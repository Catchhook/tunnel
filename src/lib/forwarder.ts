import type { WebhookData } from "./cable-client.js";

// Headers that should not be forwarded (hop-by-hop and connection-specific)
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
]);

export type FailureCategory =
  | "connection_refused"
  | "timeout"
  | "dns_error"
  | "tls_error"
  | "http_error"
  | "unknown_error";

export interface ResponseEvidence {
  contentType: string | null;
  headers: Record<string, string>;
  body: string | null;
  bodyEncoding: "utf8" | "base64" | null;
  declaredContentLength: number | null;
  decodedBytesObserved: number;
  retainedBytes: number;
  captureComplete: boolean;
  truncationReason: "size_limit" | "timeout" | "stream_error" | null;
}

export interface ForwardResult {
  statusCode: number;
  statusText: string;
  responseTimeMs: number;
  error?: string;
  failureCategory?: FailureCategory;
  resolvedUrl: string;
  evidence: ResponseEvidence;
}

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type", "content-length", "location", "x-request-id", "x-correlation-id",
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
]);
const MAX_RESPONSE_HEADERS_BYTES = 16 * 1024;

// HTTP methods that MUST NOT have a request body (Node fetch throws otherwise)
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export async function forwardToLocalhost(
  data: WebhookData,
  targetUrl: string,
  evidenceBodyLimit: number | null = 64 * 1024,
  timeoutMs = 30_000,
  redirect: RequestRedirect = "follow"
): Promise<ForwardResult> {
  const start = performance.now();
  let url: URL | undefined;

  try {
    url = resolveTargetUrl(data, targetUrl);
    // Build headers, stripping hop-by-hop
    const headers: Record<string, string> = {};
    if (data.headers) {
      for (const [key, value] of Object.entries(data.headers)) {
        // ActionCable headers come with HTTP_ prefix from Rails, normalize them
        const normalizedKey = key
          .replace(/^HTTP_/, "")
          .replace(/_/g, "-")
          .toLowerCase();

        if (!HOP_BY_HOP_HEADERS.has(normalizedKey)) {
          headers[normalizedKey] = value;
        }
      }
    }

    // Add tunnel-specific headers
    headers["x-catchhook-tunnel"] = "true";
    headers["x-catchhook-request-id"] = data.id;
    if (data.ip_address) {
      headers["x-forwarded-for"] = data.ip_address;
    }
    if (data.content_type) {
      headers["content-type"] = data.content_type;
    }

    // GET/HEAD must not have a body — Node fetch throws otherwise
    const method = data.method.toUpperCase();
    const body = BODYLESS_METHODS.has(method) ? undefined : data.body;

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      redirect,
      // @ts-ignore -- Node.js fetch supports this
      signal: AbortSignal.timeout(timeoutMs),
    });

    const evidence = evidenceBodyLimit == null
      ? await drainResponse(response)
      : await captureResponseEvidence(response, evidenceBodyLimit);

    const elapsed = Math.round(performance.now() - start);

    const result: ForwardResult = {
      statusCode: response.status,
      statusText: response.statusText,
      responseTimeMs: elapsed,
      resolvedUrl: url.toString(),
      evidence,
    };

    if (response.status < 200 || response.status >= 300) {
      result.failureCategory = "http_error";
    }

    return result;
  } catch (err: any) {
    const elapsed = Math.round(performance.now() - start);
    const resolvedUrl = url?.toString() ?? targetUrl;

    if (err.name === "AbortError" || err.code === "ABORT_ERR") {
      return failureResult(resolvedUrl, elapsed, "Timeout", `Request timed out (${timeoutMs}ms)`, "timeout");
    }

    if (err.cause?.code === "ECONNREFUSED") {
      return failureResult(resolvedUrl, elapsed, "Connection Refused", `Cannot connect to ${targetUrl}`, "connection_refused");
    }

    const message = err.message || "Unknown error";
    const category = classifyError(err);

    return {
      statusCode: 0,
      statusText: "Error",
      responseTimeMs: elapsed,
      error: message,
      failureCategory: category,
      resolvedUrl,
      evidence: emptyEvidence(),
    };
  }
}

async function drainResponse(response: Response): Promise<ResponseEvidence> {
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (!(await reader.read()).done) {
        // Drain without retaining legacy/V1 response bodies so the connection can be reused.
      }
    } catch {
      // Legacy forwarding historically reports the HTTP status even if draining fails.
    } finally {
      reader.releaseLock();
    }
  }
  return emptyEvidence();
}

export function resolveTargetUrl(data: WebhookData, targetUrl: string): URL {
  const url = new URL(targetUrl);
  if (data.path) {
    const base = url.pathname.replace(/\/+$/, "");
    url.pathname = base + data.path;
  }
  if (data.query_parameters) {
    for (const [key, value] of Object.entries(data.query_parameters)) url.searchParams.set(key, value);
  }
  return url;
}

async function captureResponseEvidence(response: Response, limit: number): Promise<ResponseEvidence> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (!RESPONSE_HEADER_ALLOWLIST.has(normalized) || Buffer.byteLength(value) > 4096) return;
    const candidate = { ...headers, [normalized]: value };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_RESPONSE_HEADERS_BYTES) headers[normalized] = value;
  });
  const declared = parseNonnegativeInteger(response.headers.get("content-length"));
  if (!response.body) return { ...emptyEvidence(), contentType: response.headers.get("content-type"), headers, declaredContentLength: declared, captureComplete: true };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let retained = 0;
  let observed = 0;
  let complete = true;
  let reason: ResponseEvidence["truncationReason"] = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      observed += chunk.length;
      const remaining = limit - retained;
      if (remaining > 0) {
        const piece = chunk.subarray(0, remaining);
        chunks.push(piece);
        retained += piece.length;
      }
      if (observed > limit) {
        observed = limit + 1;
        complete = false;
        reason = "size_limit";
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (error: any) {
    complete = false;
    reason = error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "stream_error";
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks, retained);
  let body: string;
  let bodyEncoding: "utf8" | "base64";
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    bodyEncoding = "utf8";
  } catch {
    body = bytes.toString("base64");
    bodyEncoding = "base64";
  }
  return {
    contentType: response.headers.get("content-type"), headers, body, bodyEncoding,
    declaredContentLength: declared, decodedBytesObserved: observed, retainedBytes: bytes.length,
    captureComplete: complete, truncationReason: reason,
  };
}

function emptyEvidence(): ResponseEvidence {
  return {
    contentType: null, headers: {}, body: null, bodyEncoding: null,
    declaredContentLength: null, decodedBytesObserved: 0, retainedBytes: 0,
    captureComplete: false, truncationReason: null,
  };
}

function failureResult(resolvedUrl: string, elapsed: number, statusText: string, error: string, failureCategory: FailureCategory): ForwardResult {
  return { statusCode: 0, statusText, responseTimeMs: elapsed, error, failureCategory, resolvedUrl, evidence: emptyEvidence() };
}

function parseNonnegativeInteger(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function classifyError(err: any): FailureCategory {
  const code = err.cause?.code || err.code || "";
  const msg = (err.message || "").toLowerCase();

  if (code === "ENOTFOUND" || msg.includes("getaddrinfo") || msg.includes("dns")) {
    return "dns_error";
  }
  if (code === "ERR_TLS" || msg.includes("tls") || msg.includes("ssl") || msg.includes("certificate")) {
    return "tls_error";
  }
  if (code === "ECONNREFUSED" || msg.includes("econnrefused")) {
    return "connection_refused";
  }
  if (msg.includes("timeout") || msg.includes("abort")) {
    return "timeout";
  }
  return "unknown_error";
}
