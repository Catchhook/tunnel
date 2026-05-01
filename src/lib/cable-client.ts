import { createConsumer, adapters, type Consumer, type Subscription } from "@rails/actioncable";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getHost, getProtocol, getWsProtocol } from "./constants.js";
import { ApiClient, getAnonymousTunnelTicket } from "./api-client.js";

const DEBUG = !!process.env.DEBUG;

function debug(...args: any[]): void {
  if (DEBUG) {
    const ts = new Date().toISOString();
    process.stderr.write(`[debug ${ts}] ${args.map(String).join(" ")}\n`);
  }
}

// ActionCable captures `WebSocket` at import time via its `adapters` module.
// In Node.js, `WebSocket` isn't a global, so `adapters.WebSocket` ends up as
// `undefined` unless we patch it AFTER the import. We wrap the `ws` library
// to inject an Origin header matching the CatchHook host.
function createOriginWebSocket(host: string) {
  const origin = `${getProtocol(host)}://${host}`;
  return class OriginWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { Origin: origin } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

// Patch ActionCable's adapter directly — this is what it actually uses
// to create WebSocket connections. Setting globalThis.WebSocket alone is
// insufficient because adapters.WebSocket was already captured as `undefined`
// during the @rails/actioncable module evaluation.
function setWebSocketClass(host: string): void {
  const WsClass = createOriginWebSocket(host);
  (adapters as any).WebSocket = WsClass;
  (globalThis as any).WebSocket = WsClass;
}

setWebSocketClass(getHost());

// ConnectionMonitor calls addEventListener("visibilitychange", ...) and
// checks document.visibilityState — stub these as no-ops for Node.js
if (typeof globalThis.addEventListener === "undefined") {
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
}
if (typeof globalThis.document === "undefined") {
  (globalThis as any).document = { visibilityState: "visible" };
}

export interface WebhookData {
  type: string;
  id: string;
  method: string;
  path: string | null;
  headers: Record<string, string>;
  body: Buffer | null;
  body_encoding: string;
  body_size: number;
  query_parameters: Record<string, string>;
  content_type: string | null;
  ip_address: string | null;
  requested_at: string;
}

export type AuthMode =
  | { mode: "authenticated"; token: string; endpointId: string; host?: string }
  | { mode: "anonymous"; tunnelKey: string; endpointId: string; host?: string };

export type MultiAuthMode =
  | { mode: "authenticated"; token: string; host?: string }
  | { mode: "anonymous"; tunnelKey: string; endpointId: string; host?: string };

interface TunnelConnection {
  channel: Subscription;
  heartbeatInterval: ReturnType<typeof setInterval>;
  disconnect: () => void;
}

export interface EndpointSubscription {
  endpointId: string;
  channel: Subscription;
  heartbeatInterval: ReturnType<typeof setInterval>;
}

export interface MultiTunnelConnection {
  clientId: string;
  subscriptions: EndpointSubscription[];
  addEndpoint: (endpointId: string, callbacks: EndpointCallbacks) => EndpointSubscription;
  disconnect: () => void;
}

export interface EndpointCallbacks {
  onWebhook: (data: WebhookData) => void;
  onRejected?: () => void;
}

async function getTicketForAuth(auth: MultiAuthMode, endpointId?: string): Promise<string> {
  const host = auth.host;

  if (auth.mode === "authenticated") {
    const client = new ApiClient(auth.token, host);
    const data = await client.getTunnelTicket(endpointId || "any");
    return data.ticket;
  } else {
    const data = await getAnonymousTunnelTicket(auth.tunnelKey, host);
    return data.ticket;
  }
}

/**
 * Kill ActionCable's built-in ConnectionMonitor on a consumer.
 *
 * IMPORTANT: This must be called AFTER the WebSocket connection has opened
 * (i.e. inside the `connected()` callback), because `connection.open()` calls
 * `this.monitor.start()` which restarts the monitor. Calling stop() before
 * open() is useless — the monitor just gets restarted.
 *
 * Without this, the monitor tries to auto-reconnect using the original URL
 * (which contains an already-consumed single-use ticket), causing immediate
 * "unauthorized" rejections and an infinite disconnect/reconnect loop.
 */
function killConnectionMonitor(consumer: Consumer): void {
  try {
    const monitor = (consumer as any).connection?.monitor;
    if (monitor && typeof monitor.stop === "function") {
      monitor.stop();
      debug("ConnectionMonitor stopped");
    } else {
      debug("ConnectionMonitor not found on consumer");
    }
  } catch (e) {
    debug("Failed to stop ConnectionMonitor:", e);
  }
}

/**
 * Connect a multi-endpoint tunnel. Creates a single WebSocket consumer and
 * allows subscribing to multiple endpoints via addEndpoint(). All subscriptions
 * share the same clientId so the server can group them as one logical connection.
 *
 * initialEndpointId is required for authenticated mode so the ticket exchange
 * can reference a valid endpoint the user owns.
 */
export async function connectMultiTunnel(
  auth: MultiAuthMode,
  connectionCallbacks: {
    onConnected: () => void;
    onDisconnected: () => void;
    onReconnecting: () => void;
    onRejected?: () => void;
  },
  initialEndpointId?: string,
  targetUrl?: string
): Promise<MultiTunnelConnection> {
  const host = auth.host || getHost();
  const wsProtocol = getWsProtocol(host);

  setWebSocketClass(host);

  const clientId = randomUUID();
  debug("clientId:", clientId);

  let currentConsumer: Consumer;
  let reconnectAttempts = 0;
  const maxReconnectDelay = 30_000;
  let reconnecting = false;

  let connectionGeneration = 0;
  let intentionalTeardownGeneration: number | null = null;
  let connectedFiredForGeneration: number | null = null;

  // Track all active endpoint subscriptions for re-subscribing on reconnect
  const endpointEntries: Map<string, { callbacks: EndpointCallbacks; sub: EndpointSubscription }> = new Map();

  function startHeartbeat(channel: Subscription): ReturnType<typeof setInterval> {
    return setInterval(() => {
      try { (channel as any).perform("heartbeat"); } catch { /* ignore if disconnected */ }
    }, 60_000);
  }

  function teardownCurrent(): void {
    debug("teardownCurrent: clearing heartbeats and unsubscribing");
    for (const entry of endpointEntries.values()) {
      clearInterval(entry.sub.heartbeatInterval);
      try { entry.sub.channel?.unsubscribe(); } catch { /* ignore */ }
    }
    try { currentConsumer?.disconnect(); } catch { /* ignore */ }
  }

  function subscribeEndpoint(
    consumer: Consumer,
    generation: number,
    endpointId: string,
    callbacks: EndpointCallbacks
  ): EndpointSubscription {
    let monitorKilled = false;

    const channel = consumer.subscriptions.create(
      { channel: "TunnelChannel", endpoint_id: endpointId, client_id: clientId, target_url: targetUrl },
      {
        connected() {
          debug(`connected() fired for endpoint ${endpointId}, gen=${generation}`);
          if (!monitorKilled) {
            killConnectionMonitor(consumer);
            monitorKilled = true;
          }

          reconnectAttempts = 0;
          reconnecting = false;
          intentionalTeardownGeneration = null;

          if (connectedFiredForGeneration !== generation) {
            connectedFiredForGeneration = generation;
            connectionCallbacks.onConnected();
          }
        },

        disconnected() {
          debug(`disconnected() fired for endpoint ${endpointId}, gen=${generation}, current=${connectionGeneration}`);
          if (generation !== connectionGeneration || generation === intentionalTeardownGeneration) {
            debug("disconnected: ignoring (stale generation or intentional teardown)");
            return;
          }
          scheduleReconnect("WebSocket disconnected");
        },

        rejected() {
          debug(`rejected() fired for endpoint ${endpointId}, gen=${generation}`);
          if (callbacks.onRejected) {
            callbacks.onRejected();
          } else if (connectionCallbacks.onRejected) {
            connectionCallbacks.onRejected();
          } else {
            scheduleReconnect("subscription rejected by server");
          }
        },

        received(data: any) {
          if (data.type !== "webhook_request") return;

          let bodyBuffer: Buffer | null = null;
          if (data.body && data.body_encoding === "base64") {
            bodyBuffer = Buffer.from(data.body, "base64");
          } else if (data.body) {
            bodyBuffer = Buffer.from(data.body);
          }

          callbacks.onWebhook({
            ...data,
            body: bodyBuffer,
          });
        },
      }
    );

    const heartbeatInterval = startHeartbeat(channel);

    return { endpointId, channel, heartbeatInterval };
  }

  function resubscribeAll(consumer: Consumer, generation: number): void {
    for (const [epId, entry] of endpointEntries) {
      entry.sub = subscribeEndpoint(consumer, generation, epId, entry.callbacks);
    }
  }

  async function doReconnect(): Promise<void> {
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
    reconnectAttempts++;
    debug(`doReconnect: attempt ${reconnectAttempts}, delay ${delay}ms`);

    await new Promise((r) => setTimeout(r, delay));

    const firstEndpointId = endpointEntries.keys().next().value;
    let newTicket: string;
    try {
      newTicket = await getTicketForAuth(auth, firstEndpointId);
      debug("doReconnect: got fresh ticket");
    } catch (ticketErr: any) {
      const msg = ticketErr?.message || "";
      if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("Unauthorized")) {
        const hint = auth.mode === "authenticated"
          ? "API token may be expired or revoked. Run `catchhook-tunnel auth login` to re-authenticate."
          : "Tunnel key is invalid or the endpoint has expired.";
        throw new Error(hint);
      }
      throw ticketErr;
    }
    const newUrl = `${wsProtocol}://${host}/cable?ticket=${newTicket}`;

    intentionalTeardownGeneration = connectionGeneration;
    connectionGeneration++;
    teardownCurrent();

    currentConsumer = createConsumer(newUrl);
    resubscribeAll(currentConsumer, connectionGeneration);
    debug("doReconnect: new consumer created with all subscriptions, gen=", connectionGeneration);
  }

  function scheduleReconnect(reason: string): void {
    if (reconnecting) {
      debug("scheduleReconnect: already reconnecting, ignoring:", reason);
      return;
    }
    reconnecting = true;
    debug("scheduleReconnect: starting, reason:", reason);

    for (const entry of endpointEntries.values()) {
      clearInterval(entry.sub.heartbeatInterval);
    }

    connectionCallbacks.onDisconnected();
    connectionCallbacks.onReconnecting();

    (async () => {
      const maxAttempts = 12;
      while (reconnectAttempts < maxAttempts) {
        try {
          await doReconnect();
          return;
        } catch (err: any) {
          const nextDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
          const msg = err?.message || "unknown error";
          process.stderr.write(`  Reconnect attempt ${reconnectAttempts} failed (${msg}), retrying in ${nextDelay / 1000}s...\n`);
        }
      }
      reconnecting = false;
      process.stderr.write("  Failed to reconnect after multiple attempts. Press Ctrl+C to exit.\n");
    })();
  }

  // Initial connection -- use the provided endpoint for the ticket exchange
  connectionGeneration++;
  const ticketEndpointId = initialEndpointId || (auth.mode === "anonymous" ? auth.endpointId : undefined);
  if (!ticketEndpointId) {
    throw new Error("initialEndpointId is required for authenticated multi-tunnel connections");
  }
  const ticket = await getTicketForAuth(auth, ticketEndpointId);
  const initialUrl = `${wsProtocol}://${host}/cable?ticket=${ticket}`;
  debug("Initial connection to", initialUrl.replace(/ticket=.*/, "ticket=<redacted>"));

  currentConsumer = createConsumer(initialUrl);

  function addEndpoint(endpointId: string, callbacks: EndpointCallbacks): EndpointSubscription {
    const existing = endpointEntries.get(endpointId);
    if (existing) {
      debug("addEndpoint: already subscribed to", endpointId, "— reusing");
      return existing.sub;
    }

    const sub = subscribeEndpoint(currentConsumer, connectionGeneration, endpointId, callbacks);
    endpointEntries.set(endpointId, { callbacks, sub });
    return sub;
  }

  const disconnect = () => {
    debug("disconnect() called — intentional teardown");
    intentionalTeardownGeneration = connectionGeneration;
    connectionGeneration++;
    teardownCurrent();
  };

  return {
    clientId,
    get subscriptions() { return Array.from(endpointEntries.values()).map((e) => e.sub); },
    addEndpoint,
    disconnect,
  };
}

/**
 * Single-endpoint convenience wrapper around connectMultiTunnel.
 * Maintains the original API for backwards compatibility.
 */
export async function connectTunnel(
  auth: AuthMode,
  callbacks: {
    onConnected: () => void;
    onDisconnected: () => void;
    onWebhook: (data: WebhookData) => void;
    onReconnecting: () => void;
    onRejected?: () => void;
  },
  targetUrl?: string
): Promise<TunnelConnection> {
  const multiAuth: MultiAuthMode = auth.mode === "authenticated"
    ? { mode: "authenticated", token: auth.token, host: auth.host }
    : { mode: "anonymous", tunnelKey: auth.tunnelKey, endpointId: auth.endpointId, host: auth.host };

  const multi = await connectMultiTunnel(multiAuth, {
    onConnected: callbacks.onConnected,
    onDisconnected: callbacks.onDisconnected,
    onReconnecting: callbacks.onReconnecting,
    onRejected: callbacks.onRejected,
  }, auth.endpointId, targetUrl);

  const sub = multi.addEndpoint(auth.endpointId, {
    onWebhook: callbacks.onWebhook,
    onRejected: callbacks.onRejected,
  });

  return {
    get channel() { return sub.channel; },
    get heartbeatInterval() { return sub.heartbeatInterval; },
    disconnect: multi.disconnect,
  };
}
