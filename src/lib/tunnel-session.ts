import { ApiClient, reportAnonymousDelivery, type EndpointData, type MissedWebhookData } from "./api-client.js";
import { connectTunnel, connectMultiTunnel, type AuthMode, type MultiAuthMode, type WebhookData } from "./cable-client.js";
import { forwardToLocalhost, type ForwardResult } from "./forwarder.js";
import { getReplayWarning } from "./providers.js";
import * as ui from "./ui.js";

export type CatchUpFetcher = (endpointIds: string[]) => Promise<MissedWebhookData[]>;

export async function runSingleTunnel(
  auth: AuthMode,
  targetUrl: string,
  client: ApiClient | null,
  endpoint: EndpointData,
  catchUpFetcher?: CatchUpFetcher
): Promise<void> {
  let wasConnected = false;
  const tracker = createDeliveryTracker();
  let catchUpInFlight: Promise<void> | null = null;

  const connection = await connectTunnel(auth, {
    onConnected() {
      if (catchUpFetcher && !catchUpInFlight) {
        catchUpInFlight = runCatchUp(catchUpFetcher, tracker, [endpoint], targetUrl, client, auth)
          .finally(() => { catchUpInFlight = null; });
      }
      if (wasConnected) {
        ui.success("Reconnected to CatchHook.");
      } else {
        ui.success("Connected! Listening for webhooks...");
      }
      wasConnected = true;
    },
    onDisconnected() {
      ui.warn("Disconnected from CatchHook. Reconnecting...");
    },
    onReconnecting() {},
    onRejected() {
      ui.error("Tunnel subscription rejected by server. Check your endpoint ID and account limits.");
    },
    async onWebhook(data: WebhookData) {
      tracker.track(data);
      const result: ForwardResult = await forwardToLocalhost(data, targetUrl);
      ui.requestLog(data.method, data.path, result, {
        endpointName: endpoint.name,
        contentType: data.content_type,
        bodySize: data.body_size,
        ipAddress: data.ip_address,
        detectedProvider: data.detected_provider,
        providerEventType: data.provider_event_data?.event_type,
      });

      reportDelivery(client, auth, data, endpoint.id, targetUrl, result);
    },
  }, targetUrl);

  setupShutdown(connection.disconnect);
  await new Promise(() => {});
}

export async function runMultiTunnel(
  token: string,
  host: string,
  targetUrl: string,
  client: ApiClient,
  endpoints: EndpointData[],
  catchUpFetcher?: CatchUpFetcher
): Promise<void> {
  let wasConnected = false;
  const tracker = createDeliveryTracker();
  let catchUpInFlight: Promise<void> | null = null;

  const multiAuth: MultiAuthMode = { mode: "authenticated", token, host };

  const connection = await connectMultiTunnel(multiAuth, {
    onConnected() {
      if (catchUpFetcher && !catchUpInFlight) {
        catchUpInFlight = runCatchUp(catchUpFetcher, tracker, endpoints, targetUrl, client, multiAuth)
          .finally(() => { catchUpInFlight = null; });
      }
      if (wasConnected) {
        ui.success("Reconnected to CatchHook.");
      } else {
        ui.success("Connected! Listening for webhooks...");
      }
      wasConnected = true;
    },
    onDisconnected() {
      ui.warn("Disconnected from CatchHook. Reconnecting...");
    },
    onReconnecting() {},
    onRejected() {
      ui.error("Tunnel subscription rejected by server. Check your endpoint IDs and account limits.");
    },
  }, endpoints[0].id, targetUrl);

  for (const endpoint of endpoints) {
    connection.addEndpoint(endpoint.id, {
      async onWebhook(data: WebhookData) {
        tracker.track(data);
        const result: ForwardResult = await forwardToLocalhost(data, targetUrl);
        ui.requestLog(data.method, data.path, result, {
          endpointName: endpoint.name,
          contentType: data.content_type,
          bodySize: data.body_size,
          ipAddress: data.ip_address,
          detectedProvider: data.detected_provider,
          providerEventType: data.provider_event_data?.event_type,
        });

        const auth: AuthMode = { mode: "authenticated", token, endpointId: endpoint.id, host };
        reportDelivery(client, auth, data, endpoint.id, targetUrl, result);
      },
      onRejected() {
        ui.error(`Tunnel subscription rejected for endpoint "${endpoint.name}" (${endpoint.id}). Check account limits.`);
      },
    });
  }

  setupShutdown(connection.disconnect);
  await new Promise(() => {});
}

const MAX_TRACKED_IDS = 500;

export interface DeliveryTracker {
  readonly forwardedIds: Set<string>;
  track(data: WebhookData | MissedWebhookData): void;
}

export function createDeliveryTracker(): DeliveryTracker {
  const forwardedIds = new Set<string>();
  const tracker: DeliveryTracker = {
    forwardedIds,
    track(data: WebhookData | MissedWebhookData) {
      forwardedIds.add(data.id);
      if (forwardedIds.size > MAX_TRACKED_IDS) {
        const first = forwardedIds.values().next().value;
        if (first) forwardedIds.delete(first);
      }
    },
  };
  return tracker;
}

export async function runCatchUp(
  fetcher: CatchUpFetcher,
  tracker: DeliveryTracker,
  endpoints: EndpointData[],
  targetUrl: string,
  client: ApiClient | null,
  auth: AuthMode | MultiAuthMode
): Promise<void> {
  try {
    const endpointIds = endpoints.map((ep) => ep.id);
    const missed = await fetcher(endpointIds);
    const toReplay = missed.filter((d) => !tracker.forwardedIds.has(d.id));

    if (toReplay.length === 0) return;

    ui.info(`Catching up: replaying ${toReplay.length} missed webhook(s)...`);

    for (const data of toReplay) {
      if (tracker.forwardedIds.has(data.id)) continue;
      tracker.track(data);
      const endpoint = endpoints.find((ep) => ep.id === data.endpoint_id) || endpoints[0];

      const warning = getReplayWarning(
        data.detected_provider,
        data.provider_event_data?.event_type
      );
      if (warning) {
        ui.warn(`Replay warning (${data.id}): ${warning}`);
      }

      const result: ForwardResult = await forwardToLocalhost(data, targetUrl);
      ui.requestLog(data.method, data.path, result, {
        endpointName: endpoint.name,
        contentType: data.content_type,
        bodySize: data.body_size,
        ipAddress: data.ip_address,
        replay: true,
        detectedProvider: data.detected_provider,
        providerEventType: data.provider_event_data?.event_type,
      });

      if ("endpointId" in auth) {
        reportDelivery(client, auth as AuthMode, data, (auth as AuthMode).endpointId, targetUrl, result);
      } else if (auth.mode === "authenticated") {
        const epAuth: AuthMode = { mode: "authenticated", token: auth.token, endpointId: endpoint.id, host: auth.host };
        reportDelivery(client, epAuth, data, endpoint.id, targetUrl, result);
      }
    }
  } catch (err: any) {
    const msg = err.message || "unknown error";
    ui.warn(`Catch-up failed: ${msg.length > 200 ? msg.slice(0, 200) + "…" : msg}`);
  }
}

function reportDelivery(
  client: ApiClient | null,
  auth: AuthMode,
  data: WebhookData,
  endpointId: string,
  targetUrl: string,
  result: ForwardResult
): void {
  if (client && auth.mode === "authenticated") {
    client.reportDelivery({
      webhook_request_id: data.id,
      endpoint_id: endpointId,
      status_code: result.statusCode,
      response_time_ms: result.responseTimeMs,
      target_url: targetUrl,
      response_message: result.error || result.statusText || undefined,
      failure_category: result.failureCategory || undefined,
    }).catch(() => {});
  } else if (auth.mode === "anonymous") {
    reportAnonymousDelivery(
      {
        tunnel_key: auth.tunnelKey,
        webhook_request_id: data.id,
        endpoint_id: endpointId,
        status_code: result.statusCode,
        response_time_ms: result.responseTimeMs,
        target_url: targetUrl,
        response_message: result.error || result.statusText || undefined,
        failure_category: result.failureCategory || undefined,
      },
      auth.host
    ).catch(() => {});
  }
}

export function setupShutdown(disconnect: () => void): void {
  let shuttingDown = false;
  process.once("SIGINT", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log();
    ui.info("Disconnecting...");
    disconnect();
    process.exit(0);
  });
}
