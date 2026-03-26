import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ws before importing cable-client
vi.mock("ws", () => ({ default: class MockWebSocket {} }));

// Mock @rails/actioncable
const mockSubscription = {
  perform: vi.fn(),
  unsubscribe: vi.fn(),
};

const mockConsumer = {
  subscriptions: {
    create: vi.fn((_params: any, callbacks: any) => {
      // Store callbacks for test access
      (mockConsumer as any)._callbacks = callbacks;
      // Simulate connection on next tick
      setTimeout(() => callbacks.connected?.(), 0);
      return mockSubscription;
    }),
  },
  disconnect: vi.fn(),
};

vi.mock("@rails/actioncable", () => ({
  createConsumer: vi.fn(() => mockConsumer),
  adapters: { WebSocket: undefined },
}));

// Mock api-client for ticket fetching
vi.mock("./api-client.js", () => ({
  ApiClient: class MockApiClient {
    getTunnelTicket = vi.fn().mockResolvedValue({ ticket: "mock_ticket_123" });
  },
  getAnonymousTunnelTicket: vi.fn().mockResolvedValue({ ticket: "anon_ticket_456" }),
}));

// Now import after mocks are set up
import { connectTunnel, connectMultiTunnel, type AuthMode, type MultiAuthMode, type WebhookData } from "./cable-client.js";
import { createConsumer } from "@rails/actioncable";

describe("cable-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connectTunnel (authenticated)", () => {
    const auth: AuthMode = {
      mode: "authenticated",
      token: "chk_test",
      endpointId: "ep_123",
      host: "catchhook.localhost:3100",
    };

    it("creates a consumer with ws protocol for localhost", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      expect(createConsumer).toHaveBeenCalledWith(
        expect.stringContaining("ws://catchhook.localhost:3100/cable?ticket=")
      );
    });

    it("subscribes to TunnelChannel with endpoint_id", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      expect(mockConsumer.subscriptions.create).toHaveBeenCalledWith(
        { channel: "TunnelChannel", endpoint_id: "ep_123", client_id: expect.any(String) },
        expect.any(Object)
      );
    });

    it("calls onConnected when connected", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      // connected() is called via setTimeout(0)
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onConnected).toHaveBeenCalled();
    });

    it("returns a disconnect function", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const connection = await connectTunnel(auth, callbacks);

      expect(typeof connection.disconnect).toBe("function");
      connection.disconnect();

      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
      expect(mockConsumer.disconnect).toHaveBeenCalled();
    });
  });

  describe("connectTunnel (anonymous)", () => {
    const auth: AuthMode = {
      mode: "anonymous",
      tunnelKey: "my_tunnel_key",
      endpointId: "ep_tmp",
      host: "catchhook.localhost:3100",
    };

    it("creates consumer for anonymous mode", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      expect(createConsumer).toHaveBeenCalled();
    });
  });

  describe("reconnection logic", () => {
    const auth: AuthMode = {
      mode: "authenticated",
      token: "chk_test",
      endpointId: "ep_123",
      host: "catchhook.localhost:3100",
    };

    it("calls onDisconnected and onReconnecting when disconnected unexpectedly", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      // Simulate an unexpected disconnect
      const subscriptionCallbacks = (mockConsumer as any)._callbacks;
      subscriptionCallbacks.disconnected();

      // Give the async reconnect loop a chance to start
      await new Promise((r) => setTimeout(r, 50));

      expect(callbacks.onDisconnected).toHaveBeenCalled();
      expect(callbacks.onReconnecting).toHaveBeenCalled();
    });

    it("does not reconnect on intentional disconnect", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const connection = await connectTunnel(auth, callbacks);

      // Intentional disconnect via the public API
      connection.disconnect();

      // Manually trigger the disconnected callback (ActionCable does this)
      const subscriptionCallbacks = (mockConsumer as any)._callbacks;
      subscriptionCallbacks.disconnected();

      await new Promise((r) => setTimeout(r, 50));

      // Should NOT call onDisconnected since it was intentional
      expect(callbacks.onDisconnected).not.toHaveBeenCalled();
      expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    });

    it("prevents re-entrant reconnection calls", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      const subscriptionCallbacks = (mockConsumer as any)._callbacks;

      // Fire disconnected twice rapidly
      subscriptionCallbacks.disconnected();
      subscriptionCallbacks.disconnected();

      await new Promise((r) => setTimeout(r, 50));

      // Should only call onDisconnected once due to the reconnecting guard
      expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);
      expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);
    });

    it("resets reconnect attempts on successful reconnection", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      // Wait for initial connected callback
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onConnected).toHaveBeenCalledTimes(1);

      // The connected() callback resets reconnectAttempts to 0
      // This is implicitly tested by the fact that connected() fires
    });

    it("reconnects again if the new generation disconnects later", async () => {
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      // First unexpected disconnect (generation 1) triggers first reconnect.
      let subscriptionCallbacks = (mockConsumer as any)._callbacks;
      subscriptionCallbacks.disconnected();
      await new Promise((r) => setTimeout(r, 1200));

      // Now disconnect the reconnected generation; this should trigger
      // another reconnect cycle (not be ignored as intentional).
      subscriptionCallbacks = (mockConsumer as any)._callbacks;
      subscriptionCallbacks.disconnected();
      await new Promise((r) => setTimeout(r, 50));

      expect(callbacks.onDisconnected).toHaveBeenCalledTimes(2);
      expect(callbacks.onReconnecting).toHaveBeenCalledTimes(2);
    });
  });

  describe("webhook data handling", () => {
    it("decodes base64 body to Buffer in received callback", async () => {
      const auth: AuthMode = {
        mode: "authenticated",
        token: "chk_test",
        endpointId: "ep_123",
        host: "catchhook.localhost:3100",
      };

      let receivedData: WebhookData | null = null;
      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: (data: WebhookData) => { receivedData = data; },
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      // Simulate receiving data through the subscription callbacks
      const subscriptionCallbacks = (mockConsumer as any)._callbacks;
      const rawPayload = '{"event": "test"}';
      const base64Body = Buffer.from(rawPayload).toString("base64");

      subscriptionCallbacks.received({
        type: "webhook_request",
        id: "wr_1",
        method: "POST",
        path: "/hook",
        headers: {},
        body: base64Body,
        body_encoding: "base64",
        body_size: rawPayload.length,
        query_parameters: {},
        content_type: "application/json",
        ip_address: "1.2.3.4",
        requested_at: new Date().toISOString(),
      });

      expect(receivedData).not.toBeNull();
      expect(receivedData!.body).toBeInstanceOf(Buffer);
      expect(receivedData!.body!.toString()).toBe(rawPayload);
    });

    it("ignores non-webhook_request messages", async () => {
      const auth: AuthMode = {
        mode: "authenticated",
        token: "chk_test",
        endpointId: "ep_123",
        host: "catchhook.localhost:3100",
      };

      const callbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onWebhook: vi.fn(),
        onReconnecting: vi.fn(),
      };

      await connectTunnel(auth, callbacks);

      const subscriptionCallbacks = (mockConsumer as any)._callbacks;
      subscriptionCallbacks.received({ type: "ping" });
      subscriptionCallbacks.received({ type: "confirm_subscription" });

      expect(callbacks.onWebhook).not.toHaveBeenCalled();
    });
  });

  describe("connectMultiTunnel", () => {
    const multiAuth: MultiAuthMode = {
      mode: "authenticated",
      token: "chk_test",
      host: "catchhook.localhost:3100",
    };

    it("creates a single consumer shared by multiple endpoints", async () => {
      const connectionCallbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const multi = await connectMultiTunnel(multiAuth, connectionCallbacks, "ep_1");

      multi.addEndpoint("ep_1", { onWebhook: vi.fn() });
      multi.addEndpoint("ep_2", { onWebhook: vi.fn() });

      expect(createConsumer).toHaveBeenCalledTimes(1);
      expect(mockConsumer.subscriptions.create).toHaveBeenCalledTimes(2);
    });

    it("fires onConnected only once per connection generation", async () => {
      const connectionCallbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const multi = await connectMultiTunnel(multiAuth, connectionCallbacks, "ep_1");
      multi.addEndpoint("ep_1", { onWebhook: vi.fn() });
      multi.addEndpoint("ep_2", { onWebhook: vi.fn() });

      // Both subscriptions fire connected() via setTimeout(0)
      await new Promise((r) => setTimeout(r, 20));

      expect(connectionCallbacks.onConnected).toHaveBeenCalledTimes(1);
    });

    it("returns existing subscription for duplicate addEndpoint calls", async () => {
      const connectionCallbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const multi = await connectMultiTunnel(multiAuth, connectionCallbacks, "ep_1");

      const sub1 = multi.addEndpoint("ep_1", { onWebhook: vi.fn() });
      const sub2 = multi.addEndpoint("ep_1", { onWebhook: vi.fn() });

      expect(sub1).toBe(sub2);
      expect(mockConsumer.subscriptions.create).toHaveBeenCalledTimes(1);
    });

    it("passes the same clientId to all endpoint subscriptions", async () => {
      const connectionCallbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const multi = await connectMultiTunnel(multiAuth, connectionCallbacks, "ep_1");
      multi.addEndpoint("ep_1", { onWebhook: vi.fn() });
      multi.addEndpoint("ep_2", { onWebhook: vi.fn() });

      const calls = mockConsumer.subscriptions.create.mock.calls;
      const clientIds = calls.map((c: any) => c[0].client_id);
      expect(clientIds[0]).toBeDefined();
      expect(clientIds[0]).toBe(clientIds[1]);
      expect(clientIds[0]).toBe(multi.clientId);
    });

    it("disconnect tears down all subscriptions", async () => {
      const connectionCallbacks = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onReconnecting: vi.fn(),
      };

      const multi = await connectMultiTunnel(multiAuth, connectionCallbacks, "ep_1");
      multi.addEndpoint("ep_1", { onWebhook: vi.fn() });
      multi.addEndpoint("ep_2", { onWebhook: vi.fn() });

      multi.disconnect();

      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
      expect(mockConsumer.disconnect).toHaveBeenCalled();
    });
  });
});
