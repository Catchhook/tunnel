import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDeliveryTracker,
  defaultCatchUpMode,
  runCatchUp,
  runConnectionCatchUp,
  type DeliveryTracker,
  type CatchUpFetcher,
} from "./tunnel-session.js";
import type { WebhookData } from "./cable-client.js";
import { ApiError, type ApiClient, type MissedWebhookData, type TunnelGapData } from "./api-client.js";

vi.mock("./ui.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  requestLog: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("./forwarder.js", () => ({
  forwardToLocalhost: vi.fn().mockResolvedValue({
    statusCode: 200,
    statusText: "OK",
    responseTimeMs: 10,
  }),
}));

function stubWebhook(overrides: Partial<WebhookData> = {}): WebhookData {
  return {
    type: "webhook_request",
    id: `wr_${Math.random().toString(36).slice(2, 8)}`,
    method: "POST",
    path: "/hooks/ep_123",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
    body_encoding: "base64",
    body_size: 2,
    query_parameters: {},
    content_type: "application/json",
    ip_address: "127.0.0.1",
    requested_at: new Date().toISOString(),
    detected_provider: null,
    provider_event_data: null,
    ...overrides,
  };
}

describe("createDeliveryTracker", () => {
  let tracker: DeliveryTracker;

  beforeEach(() => {
    tracker = createDeliveryTracker();
  });

  it("starts with empty forwardedIds", () => {
    expect(tracker.forwardedIds.size).toBe(0);
  });

  it("adds id to forwardedIds on track()", () => {
    const wh = stubWebhook({ id: "wr_abc" });
    tracker.track(wh);
    expect(tracker.forwardedIds.has("wr_abc")).toBe(true);
  });

  it("evicts oldest id when exceeding 500 entries", () => {
    const firstWh = stubWebhook({ id: "wr_first" });
    tracker.track(firstWh);

    for (let i = 0; i < 500; i++) {
      tracker.track(stubWebhook({ id: `wr_fill_${i}` }));
    }

    expect(tracker.forwardedIds.has("wr_first")).toBe(false);
    expect(tracker.forwardedIds.size).toBe(500);
  });

  it("keeps the most recent entries after eviction", () => {
    for (let i = 0; i < 510; i++) {
      tracker.track(stubWebhook({ id: `wr_${i}` }));
    }

    expect(tracker.forwardedIds.has("wr_0")).toBe(false);
    expect(tracker.forwardedIds.has("wr_9")).toBe(false);
    expect(tracker.forwardedIds.has("wr_509")).toBe(true);
  });
});

function stubMissedWebhook(overrides: Partial<MissedWebhookData> = {}): MissedWebhookData {
  return {
    ...stubWebhook(overrides),
    endpoint_id: overrides.endpoint_id ?? "ep_123",
  };
}

describe("runCatchUp", () => {
  const endpoint = {
    id: "ep_123",
    name: "Test Endpoint",
    custom_id: null,
    provider: null,
    provider_config: null,
    webhook_url: "https://listen.catchhook.app/hooks/ep_123",
    tunnel_active: false,
    created_at: "",
    updated_at: "",
  };
  const targetUrl = "http://localhost:3000";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fetcher with endpoint ids", async () => {
    const tracker = createDeliveryTracker();
    const fetcher = vi.fn().mockResolvedValue([]);

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(fetcher).toHaveBeenCalledWith(["ep_123"]);
  });

  it("always calls fetcher even with empty tracker", async () => {
    const tracker = createDeliveryTracker();
    const fetcher = vi.fn().mockResolvedValue([]);

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does nothing when fetcher returns empty array", async () => {
    const tracker = createDeliveryTracker();
    const fetcher = vi.fn().mockResolvedValue([]);
    const { forwardToLocalhost } = await import("./forwarder.js");

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(forwardToLocalhost).not.toHaveBeenCalled();
  });

  it("forwards missed webhooks that are not already tracked", async () => {
    const tracker = createDeliveryTracker();
    tracker.track(stubWebhook({ id: "wr_already" }));

    const missedNew = stubMissedWebhook({ id: "wr_missed_1" });
    const missedDup = stubMissedWebhook({ id: "wr_already" });
    const fetcher = vi.fn().mockResolvedValue([missedNew, missedDup]);

    const { forwardToLocalhost } = await import("./forwarder.js");

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(forwardToLocalhost).toHaveBeenCalledTimes(1);
    expect(forwardToLocalhost).toHaveBeenCalledWith(missedNew, targetUrl);
  });

  it("deduplicates already-forwarded IDs", async () => {
    const tracker = createDeliveryTracker();
    tracker.track(stubWebhook({ id: "wr_seen_1" }));
    tracker.track(stubWebhook({ id: "wr_seen_2" }));

    const fetcher = vi.fn().mockResolvedValue([
      stubMissedWebhook({ id: "wr_seen_1" }),
      stubMissedWebhook({ id: "wr_seen_2" }),
    ]);

    const { forwardToLocalhost } = await import("./forwarder.js");

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(forwardToLocalhost).not.toHaveBeenCalled();
  });

  it("tracks newly forwarded IDs after catch-up", async () => {
    const tracker = createDeliveryTracker();

    const missedWh = stubMissedWebhook({ id: "wr_catchup_new" });
    const fetcher = vi.fn().mockResolvedValue([missedWh]);

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(tracker.forwardedIds.has("wr_catchup_new")).toBe(true);
  });

  it("handles fetcher errors gracefully without throwing", async () => {
    const tracker = createDeliveryTracker();
    const fetcher = vi.fn().mockRejectedValue(new Error("Network failure"));
    const ui = await import("./ui.js");

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("Catch-up failed"));
  });

  it("forwards all results on fresh tracker (restart scenario)", async () => {
    const tracker = createDeliveryTracker();

    const missed1 = stubMissedWebhook({ id: "wr_1" });
    const missed2 = stubMissedWebhook({ id: "wr_2" });
    const fetcher = vi.fn().mockResolvedValue([missed1, missed2]);

    const { forwardToLocalhost } = await import("./forwarder.js");

    await runCatchUp(fetcher, tracker, [endpoint], targetUrl, null, {
      mode: "anonymous", tunnelKey: "tkey_x", endpointId: "ep_123",
    });

    expect(forwardToLocalhost).toHaveBeenCalledTimes(2);
    expect(tracker.forwardedIds.has("wr_1")).toBe(true);
    expect(tracker.forwardedIds.has("wr_2")).toBe(true);
  });
});

function stubGap(overrides: Partial<TunnelGapData> = {}): TunnelGapData {
  return {
    id: "tgap_123",
    endpoint_id: "ep_123",
    endpoint_name: "Test Endpoint",
    workspace_id: "ws_123",
    status: "reconnected",
    started_at: "2026-07-10T12:00:00Z",
    detected_at: "2026-07-10T12:05:00Z",
    reconnected_at: "2026-07-17T12:00:00Z",
    target_url: "http://localhost:4000",
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
    ...overrides,
  };
}

function stubRecoveryClient(overrides: Record<string, any> = {}): ApiClient {
  return {
    getTunnelGaps: vi.fn().mockResolvedValue([stubGap()]),
    getGapRequests: vi.fn().mockResolvedValue({
      data: [stubMissedWebhook({ requested_at: "2026-07-11T12:00:00Z" })],
      meta: { next_cursor: null },
    }),
    reportDelivery: vi.fn().mockResolvedValue(undefined),
    reportGapRecovery: vi.fn().mockResolvedValue(stubGap({
      status: "reconnected",
      counts: { ...stubGap().counts, pending_count: 0, recovered_count: 1 },
    })),
    ...overrides,
  } as unknown as ApiClient;
}

describe("durable catch-up modes", () => {
  const endpoint = {
    id: "ep_123",
    name: "Test Endpoint",
    custom_id: null,
    provider: null,
    provider_config: null,
    webhook_url: "https://listen.catchhook.app/hooks/ep_123",
    tunnel_active: false,
    created_at: "",
    updated_at: "",
  };
  const auth = { mode: "authenticated" as const, token: "chk_test", endpointId: "ep_123", host: "catchhook.app" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to prompt on TTY and recent in headless mode", () => {
    expect(defaultCatchUpMode(true)).toBe("prompt");
    expect(defaultCatchUpMode(false)).toBe("recent");
  });

  it("all mode pages through a gap, forwards sequentially, and reports recovery", async () => {
    const client = stubRecoveryClient({
      reportGapRecovery: vi.fn().mockResolvedValue(stubGap({ status: "recovered" })),
    });
    const fetcher = vi.fn().mockResolvedValue([]);
    const tracker = createDeliveryTracker();
    const { forwardToLocalhost } = await import("./forwarder.js");

    await runConnectionCatchUp(fetcher, tracker, [endpoint], "http://localhost:3000", client, auth, "all");

    expect(client.getGapRequests).toHaveBeenCalledWith(["ep_123"], "tgap_123", undefined);
    expect(forwardToLocalhost).toHaveBeenCalledTimes(1);
    expect(client.reportDelivery).toHaveBeenCalledTimes(1);
    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", {
      outcome: "completed",
      attempted_count: 1,
      succeeded_count: 1,
      failed_count: 0,
    });
  });

  it("all mode follows keyset cursors and preserves oldest-first delivery", async () => {
    const older = stubMissedWebhook({ id: "wr_old", requested_at: "2026-07-11T12:00:00Z" });
    const newer = stubMissedWebhook({ id: "wr_new", requested_at: "2026-07-12T12:00:00Z" });
    const client = stubRecoveryClient({
      getGapRequests: vi.fn()
        .mockResolvedValueOnce({ data: [older], meta: { next_cursor: "page-2" } })
        .mockResolvedValueOnce({ data: [newer], meta: { next_cursor: null } }),
      reportGapRecovery: vi.fn().mockResolvedValue(stubGap({ status: "recovered" })),
    });
    const { forwardToLocalhost } = await import("./forwarder.js");

    await runConnectionCatchUp(
      vi.fn().mockResolvedValue([]),
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "all"
    );

    expect(client.getGapRequests).toHaveBeenNthCalledWith(1, ["ep_123"], "tgap_123", undefined);
    expect(client.getGapRequests).toHaveBeenNthCalledWith(2, ["ep_123"], "tgap_123", "page-2");
    expect(forwardToLocalhost).toHaveBeenNthCalledWith(1, older, "http://localhost:3000");
    expect(forwardToLocalhost).toHaveBeenNthCalledWith(2, newer, "http://localhost:3000");
  });

  it("reports accurate partial counts for localhost failures", async () => {
    const client = stubRecoveryClient({
      reportGapRecovery: vi.fn().mockResolvedValue(stubGap({ status: "partial" })),
    });
    const { forwardToLocalhost } = await import("./forwarder.js");
    vi.mocked(forwardToLocalhost).mockResolvedValueOnce({
      statusCode: 500,
      statusText: "Internal Server Error",
      responseTimeMs: 10,
    });

    await runConnectionCatchUp(
      vi.fn().mockResolvedValue([]),
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "all"
    );

    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", {
      outcome: "partial",
      attempted_count: 1,
      succeeded_count: 0,
      failed_count: 1,
    });
  });

  it("renders provider replay warnings before durable recovery delivery", async () => {
    const dangerous = stubMissedWebhook({
      requested_at: "2026-07-11T12:00:00Z",
      detected_provider: "github",
      provider_event_data: { event_type: "workflow_run" },
    });
    const client = stubRecoveryClient({
      getGapRequests: vi.fn().mockResolvedValue({
        data: [dangerous],
        meta: { next_cursor: null },
      }),
      reportGapRecovery: vi.fn().mockResolvedValue(stubGap({ status: "recovered" })),
    });
    const ui = await import("./ui.js");

    await runConnectionCatchUp(
      vi.fn().mockResolvedValue([]),
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "all"
    );

    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("Replay warning"));
  });

  it("prompt mode leaves a declined gap undelivered and reports it skipped", async () => {
    const client = stubRecoveryClient();
    const missed = stubMissedWebhook({ requested_at: "2026-07-11T12:00:00Z" });
    const fetcher = vi.fn().mockResolvedValue([missed]);
    const ui = await import("./ui.js");
    vi.mocked(ui.confirm).mockResolvedValue(false);
    const { forwardToLocalhost } = await import("./forwarder.js");

    await runConnectionCatchUp(fetcher, createDeliveryTracker(), [endpoint], "http://localhost:3000", client, auth, "prompt");

    expect(forwardToLocalhost).not.toHaveBeenCalled();
    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", {
      outcome: "skipped",
      attempted_count: 0,
      succeeded_count: 0,
      failed_count: 0,
    });
  });

  it("does not replay post-detection requests from a declined open gap", async () => {
    const openGap = stubGap({ status: "open", reconnected_at: null });
    const client = stubRecoveryClient({ getTunnelGaps: vi.fn().mockResolvedValue([openGap]) });
    const missed = stubMissedWebhook({ requested_at: "2026-07-10T12:10:00Z" });
    const fetcher = vi.fn().mockResolvedValue([missed]);
    const ui = await import("./ui.js");
    vi.mocked(ui.confirm).mockResolvedValue(false);
    const { forwardToLocalhost } = await import("./forwarder.js");

    await runConnectionCatchUp(fetcher, createDeliveryTracker(), [endpoint], "http://localhost:3000", client, auth, "prompt");

    expect(forwardToLocalhost).not.toHaveBeenCalled();
  });

  it("recent mode keeps the legacy 120-minute fetch path and reports partial progress", async () => {
    const gap = stubGap({
      started_at: "2026-07-10T12:00:00Z",
      reconnected_at: "2026-07-17T12:00:00Z",
    });
    const client = stubRecoveryClient({ getTunnelGaps: vi.fn().mockResolvedValue([gap]) });
    const missed = stubMissedWebhook({ requested_at: "2026-07-17T11:30:00Z" });
    const fetcher = vi.fn().mockResolvedValue([missed]);

    await runConnectionCatchUp(fetcher, createDeliveryTracker(), [endpoint], "http://localhost:3000", client, auth, "recent");

    expect(fetcher).toHaveBeenCalledWith(["ep_123"]);
    expect(client.getGapRequests).not.toHaveBeenCalled();
    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", expect.objectContaining({
      attempted_count: 1,
      succeeded_count: 1,
    }));
  });

  it("attributes post-detection recent attempts to an open gap", async () => {
    const openGap = stubGap({ status: "open", reconnected_at: null });
    const client = stubRecoveryClient({ getTunnelGaps: vi.fn().mockResolvedValue([openGap]) });
    const missed = stubMissedWebhook({ requested_at: "2026-07-10T12:10:00Z" });

    await runConnectionCatchUp(
      vi.fn().mockResolvedValue([missed]),
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "recent"
    );

    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", expect.objectContaining({
      attempted_count: 1,
      succeeded_count: 1,
    }));
  });

  it("none mode does not forward or resolve a backlog", async () => {
    const client = stubRecoveryClient();
    const fetcher = vi.fn().mockResolvedValue([stubMissedWebhook()]);
    const { forwardToLocalhost } = await import("./forwarder.js");

    await runConnectionCatchUp(fetcher, createDeliveryTracker(), [endpoint], "http://localhost:3000", client, auth, "none");

    expect(fetcher).not.toHaveBeenCalled();
    expect(forwardToLocalhost).not.toHaveBeenCalled();
    expect(client.reportGapRecovery).not.toHaveBeenCalled();
  });

  it("reconciles an unresolved gap whose deliveries already succeeded", async () => {
    const deliveredGap = stubGap({
      counts: {
        ...stubGap().counts,
        pending_count: 0,
        recovered_count: 1,
      },
    });
    const client = stubRecoveryClient({
      getTunnelGaps: vi.fn().mockResolvedValue([deliveredGap]),
      reportGapRecovery: vi.fn().mockResolvedValue(stubGap({ status: "recovered" })),
    });
    const fetcher = vi.fn().mockResolvedValue([]);

    await runConnectionCatchUp(
      fetcher,
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "none"
    );

    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", {
      outcome: "completed",
      attempted_count: 0,
      succeeded_count: 0,
      failed_count: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to legacy recent catch-up when the server has no gap API", async () => {
    const client = stubRecoveryClient({
      getTunnelGaps: vi.fn().mockRejectedValue(new ApiError(404, "not found")),
    });
    const fetcher = vi.fn().mockResolvedValue([]);

    await runConnectionCatchUp(fetcher, createDeliveryTracker(), [endpoint], "http://localhost:3000", client, auth, "prompt");

    expect(fetcher).toHaveBeenCalledWith(["ep_123"]);
  });

  it("keeps the live tunnel running when durable recovery lookup fails", async () => {
    const client = stubRecoveryClient({
      getTunnelGaps: vi.fn().mockRejectedValue(new ApiError(410, "gap expired")),
    });
    const fetcher = vi.fn().mockResolvedValue([]);
    const ui = await import("./ui.js");

    await expect(runConnectionCatchUp(
      fetcher,
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "all"
    )).resolves.toBeUndefined();

    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("Live tunnel delivery remains active"));
  });

  it("reports partial progress when durable recovery is interrupted", async () => {
    const controller = new AbortController();
    const first = stubMissedWebhook({ id: "wr_interrupt_1", requested_at: "2026-07-11T12:00:00Z" });
    const second = stubMissedWebhook({ id: "wr_interrupt_2", requested_at: "2026-07-12T12:00:00Z" });
    const client = stubRecoveryClient({
      getGapRequests: vi.fn().mockResolvedValue({
        data: [first, second],
        meta: { next_cursor: null },
      }),
      reportGapRecovery: vi.fn().mockResolvedValue(stubGap({ status: "partial" })),
    });
    const { forwardToLocalhost } = await import("./forwarder.js");
    vi.mocked(forwardToLocalhost).mockImplementationOnce(async () => {
      controller.abort();
      return { statusCode: 200, statusText: "OK", responseTimeMs: 10 };
    });

    await runConnectionCatchUp(
      vi.fn().mockResolvedValue([]),
      createDeliveryTracker(),
      [endpoint],
      "http://localhost:3000",
      client,
      auth,
      "all",
      controller.signal
    );

    expect(forwardToLocalhost).toHaveBeenCalledTimes(1);
    expect(client.reportGapRecovery).toHaveBeenCalledWith("tgap_123", {
      outcome: "interrupted",
      attempted_count: 1,
      succeeded_count: 1,
      failed_count: 0,
    });
  });
});
