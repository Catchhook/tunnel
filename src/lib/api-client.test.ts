import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient, ApiError, getAnonymousTunnelTicket, reportAnonymousDelivery } from "./api-client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe("ApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new ApiClient("chk_test_token", "catchhook.localhost:3100");
  });

  describe("constructor", () => {
    it("builds correct base URL for localhost", () => {
      const localClient = new ApiClient("tok", "catchhook.localhost:3100");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
      localClient.verify();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://catchhook.localhost:3100/api/v1/auth/verify",
        expect.any(Object)
      );
    });

    it("builds correct base URL for production", () => {
      const prodClient = new ApiClient("tok", "catchhook.app");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
      prodClient.verify();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://catchhook.app/api/v1/auth/verify",
        expect.any(Object)
      );
    });
  });

  describe("verify", () => {
    it("sends GET to /api/v1/auth/verify with bearer token", async () => {
      const responseData = {
        data: {
          user: { id: "u_1", email: "test@example.com", name: "Test" },
          account: { id: "a_1", name: "Test Account", plan: "pro" },
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(responseData));

      const result = await client.verify();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://catchhook.localhost:3100/api/v1/auth/verify",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer chk_test_token",
            "Content-Type": "application/json",
          }),
        })
      );
      expect(result.data.user.email).toBe("test@example.com");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("Invalid token"),
      });

      await expect(client.verify()).rejects.toThrow("API error 401: Invalid token");
    });
  });

  describe("listEndpoints", () => {
    it("returns endpoints data", async () => {
      const endpoints = {
        data: [
          { id: "ep_1", name: "Test", custom_id: null, webhook_url: "http://...", tunnel_active: false, created_at: "", updated_at: "" },
        ],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(endpoints));

      const result = await client.listEndpoints();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("ep_1");
    });
  });

  describe("createEndpoint", () => {
    it("sends POST with endpoint name", async () => {
      const newEp = { data: { id: "ep_new", name: "My Endpoint" } };
      mockFetch.mockResolvedValueOnce(jsonResponse(newEp));

      await client.createEndpoint("My Endpoint");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://catchhook.localhost:3100/api/v1/endpoints",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ endpoint: { name: "My Endpoint" } }),
        })
      );
    });
  });

  describe("getTunnelTicket", () => {
    it("sends POST with endpoint_id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ticket: "tkt_abc", expires_in: 30 }));

      const result = await client.getTunnelTicket("ep_123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://catchhook.localhost:3100/api/v1/tunnel/connect",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ endpoint_id: "ep_123" }),
        })
      );
      expect(result.ticket).toBe("tkt_abc");
    });
  });

  describe("reportDelivery", () => {
    it("sends POST with delivery data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await client.reportDelivery({
        webhook_request_id: "wr_1",
        endpoint_id: "ep_1",
        status_code: 200,
        response_time_ms: 42,
        target_url: "http://localhost:3000",
      });

      const [, fetchOpts] = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchOpts.body);
      expect(body.webhook_request_id).toBe("wr_1");
      expect(body.status_code).toBe(200);
    });
  });

  describe("error handling", () => {
    it("exposes Retry-After guidance on rate limits", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? "7" : null },
        text: () => Promise.resolve('{"error":"rate_limited"}'),
      });

      const error = await client.listEndpoints().catch((caught) => caught);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.retryAfterMs).toBe(7_000);
    });

    it("includes response body text in error message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve('{"error": "Plan limit reached"}'),
      });

      await expect(client.listEndpoints()).rejects.toThrow("API error 403");
    });

    it("handles empty response body gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve(""),
      });

      await expect(client.verify()).rejects.toThrow("API error 500: Internal Server Error");
    });
  });
});

describe("getAnonymousTunnelTicket", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends POST to connect_anonymous with tunnel_key", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ticket: "anon_tkt", expires_in: 30, endpoint_id: "ep_tmp" }));

    const result = await getAnonymousTunnelTicket("my_tunnel_key", "catchhook.localhost:3100");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://catchhook.localhost:3100/api/v1/tunnel/connect_anonymous",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tunnel_key: "my_tunnel_key" }),
      })
    );
    expect(result.ticket).toBe("anon_tkt");
  });

  it("throws specific message for 401 (expired key)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve(""),
    });

    await expect(getAnonymousTunnelTicket("bad_key")).rejects.toThrow(
      "Invalid or expired tunnel key"
    );
  });

  it("throws generic error for other status codes", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve(""),
    });

    await expect(getAnonymousTunnelTicket("key")).rejects.toThrow("API error 500");
  });
});

describe("reportAnonymousDelivery", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends POST to delivery_reports_anonymous with tunnel_key and delivery data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

    await reportAnonymousDelivery(
      {
        tunnel_key: "tkey_abc",
        webhook_request_id: "req_123",
        endpoint_id: "ep_tmp",
        status_code: 200,
        response_time_ms: 35,
        target_url: "http://localhost:3000",
      },
      "catchhook.localhost:3100"
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://catchhook.localhost:3100/api/v1/tunnel/delivery_reports_anonymous",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          tunnel_key: "tkey_abc",
          webhook_request_id: "req_123",
          endpoint_id: "ep_tmp",
          status_code: 200,
          response_time_ms: 35,
          target_url: "http://localhost:3000",
        }),
      })
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("Unauthorized"),
    });

    await expect(
      reportAnonymousDelivery({
        tunnel_key: "bad",
        webhook_request_id: "req_1",
        endpoint_id: "ep_1",
        status_code: 500,
        response_time_ms: 10,
        target_url: "http://localhost:3000",
      })
    ).rejects.toThrow("API error 401");
  });

  it("exposes anonymous rate limits through ApiError", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "Retry-After": "4" }),
      text: () => Promise.resolve('{"error":"rate_limited"}'),
    });

    const error = await reportAnonymousDelivery({
      tunnel_key: "key",
      webhook_request_id: "req_1",
      endpoint_id: "ep_1",
      status_code: 200,
      response_time_ms: 10,
      target_url: "http://localhost:3000",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(4_000);
  });
});

describe("ApiClient.getMissedRequests", () => {
  it("fetches missed requests with correct params", async () => {
    const rawData = [{
      type: "webhook_request",
      id: "wr_123",
      endpoint_id: "ep_1",
      method: "POST",
      path: "/hook",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}").toString("base64"),
      body_encoding: "base64",
      body_size: 2,
      query_parameters: {},
      content_type: "application/json",
      ip_address: "1.2.3.4",
      requested_at: "2026-03-30T12:00:00Z",
    }];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: rawData }),
    });

    const client = new ApiClient("chk_test", "catchhook.app");
    const result = await client.getMissedRequests(["ep_1", "ep_2"], "2026-03-30T11:00:00Z");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("wr_123");
    expect(result[0].body).toBeInstanceOf(Buffer);
    expect(result[0].body?.toString()).toBe("{}");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/tunnel/missed?");
    expect(url).toContain("since=2026-03-30T11%3A00%3A00Z");
    expect(url).toContain("endpoint_ids%5B%5D=ep_1");
    expect(url).toContain("endpoint_ids%5B%5D=ep_2");
  });

  it("decodes null body correctly", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{
        type: "webhook_request",
        id: "wr_null",
        endpoint_id: "ep_1",
        method: "GET",
        path: "/",
        headers: {},
        body: null,
        body_encoding: "base64",
        body_size: 0,
        query_parameters: {},
        content_type: null,
        ip_address: null,
        requested_at: "2026-03-30T12:00:00Z",
      }]}),
    });

    const client = new ApiClient("chk_test");
    const result = await client.getMissedRequests(["ep_1"], "2026-03-30T11:00:00Z");

    expect(result[0].body).toBeNull();
  });
});

describe("getAnonymousMissedRequests", () => {
  it("fetches anonymous missed requests", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{
        type: "webhook_request",
        id: "wr_anon",
        endpoint_id: "ep_tmp",
        method: "POST",
        path: "/hook",
        headers: {},
        body: Buffer.from("hello").toString("base64"),
        body_encoding: "base64",
        body_size: 5,
        query_parameters: {},
        content_type: "text/plain",
        ip_address: "5.6.7.8",
        requested_at: "2026-03-30T12:00:00Z",
      }]}),
    });

    const { getAnonymousMissedRequests } = await import("./api-client.js");
    const result = await getAnonymousMissedRequests("tkey_abc", "2026-03-30T11:00:00Z", "catchhook.app");

    expect(result).toHaveLength(1);
    expect(result[0].body?.toString()).toBe("hello");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/tunnel/missed_anonymous?");
    expect(url).toContain("tunnel_key=tkey_abc");
  });

  it("throws on 401", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const { getAnonymousMissedRequests } = await import("./api-client.js");
    await expect(
      getAnonymousMissedRequests("tkey_bad", "2026-03-30T11:00:00Z")
    ).rejects.toThrow("Invalid or expired tunnel key");
  });
});

describe("ApiClient.getUndeliveredRequests", () => {
  it("fetches undelivered requests with correct params", async () => {
    const rawData = [{
      type: "webhook_request",
      id: "wr_undelivered",
      endpoint_id: "ep_1",
      method: "POST",
      path: "/hook",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}").toString("base64"),
      body_encoding: "base64",
      body_size: 2,
      query_parameters: {},
      content_type: "application/json",
      ip_address: "1.2.3.4",
      requested_at: "2026-03-30T12:00:00Z",
    }];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: rawData }),
    });

    const client = new ApiClient("chk_test", "catchhook.app");
    const result = await client.getUndeliveredRequests(["ep_1", "ep_2"]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("wr_undelivered");
    expect(result[0].body).toBeInstanceOf(Buffer);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/tunnel/undelivered?");
    expect(url).toContain("endpoint_ids%5B%5D=ep_1");
    expect(url).toContain("endpoint_ids%5B%5D=ep_2");
    expect(url).not.toContain("minutes=");
  });

  it("passes minutes parameter when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const client = new ApiClient("chk_test", "catchhook.app");
    await client.getUndeliveredRequests(["ep_1"], 60);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("minutes=60");
  });

  it("returns empty array when no undelivered requests", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const client = new ApiClient("chk_test");
    const result = await client.getUndeliveredRequests(["ep_1"]);

    expect(result).toEqual([]);
  });
});

describe("ApiClient tunnel gap recovery", () => {
  const gap = {
    id: "tgap_123",
    endpoint_id: "ep_1",
    endpoint_name: "Payments",
    workspace_id: "ws_1",
    status: "reconnected",
    started_at: "2026-07-10T12:00:00Z",
    detected_at: "2026-07-10T12:01:00Z",
    reconnected_at: "2026-07-17T12:00:00Z",
    target_url: "http://localhost:3000",
    client_hostname: "laptop",
    recovery_outcome: null,
    retention_truncated: false,
    counts: {
      total_count: 1,
      retained_count: 1,
      pending_count: 1,
      recovered_count: 0,
      failed_count: 0,
      expired_count: 0,
    },
  };

  it("discovers unresolved gaps for requested endpoints", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [gap] }));
    const client = new ApiClient("chk_test", "catchhook.app");

    const result = await client.getTunnelGaps(["ep_1", "ep_2"]);

    expect(result[0].id).toBe("tgap_123");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/tunnel/gaps?");
    expect(url).toContain("endpoint_ids%5B%5D=ep_1");
    expect(url).toContain("endpoint_ids%5B%5D=ep_2");
  });

  it("fetches and deserializes a cursor page", async () => {
    const rawRequest = {
      type: "webhook_request",
      id: "req_1",
      endpoint_id: "ep_1",
      method: "POST",
      path: "/hooks",
      headers: {},
      body: Buffer.from("hello").toString("base64"),
      body_encoding: "base64",
      body_size: 5,
      query_parameters: {},
      content_type: "text/plain",
      ip_address: null,
      requested_at: "2026-07-10T12:01:00Z",
      detected_provider: null,
      provider_event_data: null,
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [rawRequest],
      meta: {
        gap_id: "tgap_123",
        started_at: gap.started_at,
        detected_at: gap.detected_at,
        total_count: 1,
        pending_count: 1,
        returned_count: 1,
        next_cursor: "next-token",
        retention_truncated: false,
      },
    }));
    const client = new ApiClient("chk_test", "catchhook.app");

    const page = await client.getGapRequests(["ep_1"], "tgap_123", "cursor-token", 50);

    expect(page.data[0].body?.toString()).toBe("hello");
    expect(page.meta.next_cursor).toBe("next-token");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("gap_id=tgap_123");
    expect(url).toContain("cursor=cursor-token");
    expect(url).toContain("limit=50");
  });

  it("reports recovery counts", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ...gap, status: "recovered" } }));
    const client = new ApiClient("chk_test", "catchhook.app");

    const result = await client.reportGapRecovery("tgap_123", {
      outcome: "completed",
      attempted_count: 1,
      succeeded_count: 1,
      failed_count: 0,
    });

    expect(result.status).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://catchhook.app/api/v1/tunnel/gaps/tgap_123/recovery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          outcome: "completed",
          attempted_count: 1,
          succeeded_count: 1,
          failed_count: 0,
        }),
      })
    );
  });
});
