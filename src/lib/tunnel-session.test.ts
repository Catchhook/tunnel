import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeliveryTracker, runCatchUp, type DeliveryTracker, type CatchUpFetcher } from "./tunnel-session.js";
import type { WebhookData } from "./cable-client.js";
import type { MissedWebhookData } from "./api-client.js";

vi.mock("./ui.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  requestLog: vi.fn(),
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
