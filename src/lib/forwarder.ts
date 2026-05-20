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

export interface ForwardResult {
  statusCode: number;
  statusText: string;
  responseTimeMs: number;
  error?: string;
  failureCategory?: FailureCategory;
}

// HTTP methods that MUST NOT have a request body (Node fetch throws otherwise)
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export async function forwardToLocalhost(
  data: WebhookData,
  targetUrl: string
): Promise<ForwardResult> {
  const start = performance.now();

  try {
    // Build URL: append the original webhook path so localhost routing works
    const url = new URL(targetUrl);
    if (data.path) {
      // Resolve the webhook path relative to whatever base path targetUrl has.
      // e.g. targetUrl = "http://localhost:3000/api" + path = "/webhooks/stripe"
      //   -> "http://localhost:3000/api/webhooks/stripe"
      const base = url.pathname.replace(/\/+$/, ""); // trim trailing slash
      url.pathname = base + data.path;
    }
    if (data.query_parameters) {
      for (const [key, value] of Object.entries(data.query_parameters)) {
        url.searchParams.set(key, value);
      }
    }

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
      // @ts-ignore -- Node.js fetch supports this
      signal: AbortSignal.timeout(30_000),
    });

    // Drain the response body to release the underlying socket/connection.
    // We only care about the status; ignoring the body leaks connections.
    await response.text().catch(() => {});

    const elapsed = Math.round(performance.now() - start);

    const result: ForwardResult = {
      statusCode: response.status,
      statusText: response.statusText,
      responseTimeMs: elapsed,
    };

    if (response.status < 200 || response.status >= 300) {
      result.failureCategory = "http_error";
    }

    return result;
  } catch (err: any) {
    const elapsed = Math.round(performance.now() - start);

    if (err.name === "AbortError" || err.code === "ABORT_ERR") {
      return { statusCode: 0, statusText: "Timeout", responseTimeMs: elapsed, error: "Request timed out (30s)", failureCategory: "timeout" as const };
    }

    if (err.cause?.code === "ECONNREFUSED") {
      return { statusCode: 0, statusText: "Connection Refused", responseTimeMs: elapsed, error: `Cannot connect to ${targetUrl}`, failureCategory: "connection_refused" as const };
    }

    const message = err.message || "Unknown error";
    const category = classifyError(err);

    return {
      statusCode: 0,
      statusText: "Error",
      responseTimeMs: elapsed,
      error: message,
      failureCategory: category,
    };
  }
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
