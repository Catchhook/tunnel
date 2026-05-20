import { describe, it, expect, vi, beforeEach } from "vitest";
import { forwardToLocalhost, type ForwardResult } from "./forwarder.js";
import type { WebhookData } from "./cable-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(status: number, statusText: string) {
  return { status, statusText, text: () => Promise.resolve("") };
}

function makeWebhookData(overrides: Partial<WebhookData> = {}): WebhookData {
  return {
    type: "webhook_request",
    id: "wr_test_123",
    method: "POST",
    path: "/webhooks/stripe",
    headers: {
      HTTP_ACCEPT: "application/json",
      HTTP_X_CUSTOM: "value",
    },
    body: Buffer.from('{"event": "test"}'),
    body_encoding: "base64",
    body_size: 18,
    query_parameters: {},
    content_type: "application/json",
    ip_address: "203.0.113.50",
    requested_at: new Date().toISOString(),
    detected_provider: null,
    provider_event_data: null,
    ...overrides,
  };
}

describe("forwardToLocalhost", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("forwards request to target URL with correct method", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ method: "POST", path: null });

    await forwardToLocalhost(data, "http://localhost:3000/webhook");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/webhook",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns status code and response time on success", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData();

    const result = await forwardToLocalhost(data, "http://localhost:3000");

    expect(result.statusCode).toBe(200);
    expect(result.statusText).toBe("OK");
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("appends the original webhook path to the target URL", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ path: "/webhooks/stripe" });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/webhooks/stripe");
  });

  it("appends path after existing base path", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ path: "/hooks/inbound" });

    await forwardToLocalhost(data, "http://localhost:3000/api");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/hooks/inbound");
  });

  it("handles trailing slash on base URL when appending path", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ path: "/events" });

    await forwardToLocalhost(data, "http://localhost:3000/");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/events");
  });

  it("skips path appending when path is null", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ path: null });

    await forwardToLocalhost(data, "http://localhost:3000/hook");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/hook");
  });

  it("normalizes HTTP_ prefixed headers from Rails", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({
      headers: {
        HTTP_X_STRIPE_SIGNATURE: "sig_123",
        HTTP_X_CUSTOM_HEADER: "custom_val",
      },
    });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-stripe-signature"]).toBe("sig_123");
    expect(opts.headers["x-custom-header"]).toBe("custom_val");
  });

  it("strips hop-by-hop headers", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({
      headers: {
        HTTP_HOST: "catchhook.app",
        HTTP_CONNECTION: "keep-alive",
        HTTP_TRANSFER_ENCODING: "chunked",
        HTTP_X_CUSTOM: "keep_me",
      },
    });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["host"]).toBeUndefined();
    expect(opts.headers["connection"]).toBeUndefined();
    expect(opts.headers["transfer-encoding"]).toBeUndefined();
    expect(opts.headers["x-custom"]).toBe("keep_me");
  });

  it("adds tunnel-specific headers", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({
      id: "wr_specific",
      ip_address: "1.2.3.4",
      content_type: "application/json",
    });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-catchhook-tunnel"]).toBe("true");
    expect(opts.headers["x-catchhook-request-id"]).toBe("wr_specific");
    expect(opts.headers["x-forwarded-for"]).toBe("1.2.3.4");
    expect(opts.headers["content-type"]).toBe("application/json");
  });

  it("appends query parameters to the target URL", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({
      path: null,
      query_parameters: { token: "abc", format: "json" },
    });

    await forwardToLocalhost(data, "http://localhost:3000/hook");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("token=abc");
    expect(url).toContain("format=json");
  });

  it("sends the body buffer for POST", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const body = Buffer.from('{"test": true}');
    const data = makeWebhookData({ body });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBe(body);
  });

  it("does not send body for GET requests", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ method: "GET", body: Buffer.from("should be stripped") });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });

  it("does not send body for HEAD requests", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ method: "HEAD", body: Buffer.from("should be stripped") });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });

  it("sends body for PUT requests", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const body = Buffer.from("update payload");
    const data = makeWebhookData({ method: "PUT", body });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBe(body);
  });

  it("handles null body (GET requests)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));
    const data = makeWebhookData({ method: "GET", body: null });

    await forwardToLocalhost(data, "http://localhost:3000");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });

  it("drains response body to prevent connection leaks", async () => {
    const textFn = vi.fn().mockResolvedValue("response body");
    mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK", text: textFn });
    const data = makeWebhookData();

    await forwardToLocalhost(data, "http://localhost:3000");

    expect(textFn).toHaveBeenCalled();
  });

  it("handles ECONNREFUSED error", async () => {
    const connError = new Error("fetch failed");
    (connError as any).cause = { code: "ECONNREFUSED" };
    mockFetch.mockRejectedValueOnce(connError);

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "http://localhost:9999"
    );

    expect(result.statusCode).toBe(0);
    expect(result.statusText).toBe("Connection Refused");
    expect(result.error).toContain("Cannot connect");
    expect(result.failureCategory).toBe("connection_refused");
  });

  it("handles AbortError (timeout)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "http://localhost:3000"
    );

    expect(result.statusCode).toBe(0);
    expect(result.statusText).toBe("Timeout");
    expect(result.error).toContain("timed out");
    expect(result.failureCategory).toBe("timeout");
  });

  it("handles generic errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "http://localhost:3000"
    );

    expect(result.statusCode).toBe(0);
    expect(result.statusText).toBe("Error");
    expect(result.error).toBe("DNS resolution failed");
    expect(result.failureCategory).toBe("dns_error");
  });

  it("forwards 4xx responses with http_error category", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(422, "Unprocessable Entity"));

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "http://localhost:3000"
    );

    expect(result.statusCode).toBe(422);
    expect(result.statusText).toBe("Unprocessable Entity");
    expect(result.error).toBeUndefined();
    expect(result.failureCategory).toBe("http_error");
  });

  it("forwards 5xx responses with http_error category", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(500, "Internal Server Error"));

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "http://localhost:3000"
    );

    expect(result.statusCode).toBe(500);
    expect(result.error).toBeUndefined();
    expect(result.failureCategory).toBe("http_error");
  });

  it("returns no failureCategory for successful responses", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, "OK"));

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "http://localhost:3000"
    );

    expect(result.statusCode).toBe(200);
    expect(result.failureCategory).toBeUndefined();
  });

  it("classifies TLS errors", async () => {
    const tlsError = new Error("TLS handshake failed");
    mockFetch.mockRejectedValueOnce(tlsError);

    const result = await forwardToLocalhost(
      makeWebhookData(),
      "https://localhost:3000"
    );

    expect(result.failureCategory).toBe("tls_error");
  });
});
