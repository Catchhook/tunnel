import {
  ApiClient,
  ApiError,
  reportAnonymousDelivery,
  type EndpointData,
  type MissedWebhookData,
  type TunnelGapData,
} from "./api-client.js";
import { connectTunnel, connectMultiTunnel, type AuthMode, type MultiAuthMode, type WebhookData } from "./cable-client.js";
import { forwardToLocalhost, type ForwardResult } from "./forwarder.js";
import { getReplayWarning } from "./providers.js";
import * as ui from "./ui.js";

export type CatchUpFetcher = (endpointIds: string[]) => Promise<MissedWebhookData[]>;
export type CatchUpMode = "prompt" | "all" | "recent" | "none";

export interface CatchUpAttempt {
  id: string;
  endpointId: string;
  requestedAt: string;
  succeeded: boolean;
}

export interface CatchUpResult {
  attempted: number;
  succeeded: number;
  failed: number;
  interrupted: boolean;
  attempts: CatchUpAttempt[];
}

export function defaultCatchUpMode(isTTY = Boolean(process.stdin.isTTY)): CatchUpMode {
  return isTTY ? "prompt" : "recent";
}

export async function runSingleTunnel(
  auth: AuthMode,
  targetUrl: string,
  client: ApiClient | null,
  endpoint: EndpointData,
  catchUpFetcher?: CatchUpFetcher,
  catchUpMode: CatchUpMode = defaultCatchUpMode()
): Promise<void> {
  let wasConnected = false;
  const tracker = createDeliveryTracker();
  const catchUpAbort = new AbortController();
  let catchUpInFlight: Promise<void> | null = null;

  const connection = await connectTunnel(auth, {
    onConnected() {
      if (catchUpFetcher && !catchUpInFlight) {
        catchUpInFlight = runConnectionCatchUp(
          catchUpFetcher, tracker, [endpoint], targetUrl, client, auth, catchUpMode,
          catchUpAbort.signal
        )
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

      void reportDelivery(client, auth, data, endpoint.id, targetUrl, result).catch(() => {});
    },
  }, targetUrl);

  setupShutdown(connection.disconnect, async () => {
    const pending = catchUpInFlight;
    catchUpAbort.abort();
    if (pending) await pending;
  });
  await new Promise(() => {});
}

export async function runMultiTunnel(
  token: string,
  host: string,
  targetUrl: string,
  client: ApiClient,
  endpoints: EndpointData[],
  catchUpFetcher?: CatchUpFetcher,
  catchUpMode: CatchUpMode = defaultCatchUpMode()
): Promise<void> {
  let wasConnected = false;
  const tracker = createDeliveryTracker();
  const catchUpAbort = new AbortController();
  let catchUpInFlight: Promise<void> | null = null;

  const multiAuth: MultiAuthMode = { mode: "authenticated", token, host };

  const connection = await connectMultiTunnel(multiAuth, {
    onConnected() {
      if (catchUpFetcher && !catchUpInFlight) {
        catchUpInFlight = runConnectionCatchUp(
          catchUpFetcher, tracker, endpoints, targetUrl, client, multiAuth, catchUpMode,
          catchUpAbort.signal
        )
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
        void reportDelivery(client, auth, data, endpoint.id, targetUrl, result).catch(() => {});
      },
      onRejected() {
        ui.error(`Tunnel subscription rejected for endpoint "${endpoint.name}" (${endpoint.id}). Check account limits.`);
      },
    });
  }

  setupShutdown(connection.disconnect, async () => {
    const pending = catchUpInFlight;
    catchUpAbort.abort();
    if (pending) await pending;
  });
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
  auth: AuthMode | MultiAuthMode,
  exclude?: (request: MissedWebhookData) => boolean,
  signal?: AbortSignal
): Promise<CatchUpResult> {
  const summary: CatchUpResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    interrupted: false,
    attempts: [],
  };

  try {
    const endpointIds = endpoints.map((ep) => ep.id);
    const missed = await fetcher(endpointIds);
    const toReplay = missed.filter((d) => !tracker.forwardedIds.has(d.id) && !exclude?.(d));

    if (toReplay.length === 0) return summary;

    ui.info(`Catching up: replaying ${toReplay.length} missed webhook(s)...`);

    for (const data of toReplay) {
      if (signal?.aborted) {
        summary.interrupted = true;
        break;
      }
      if (tracker.forwardedIds.has(data.id)) continue;
      const endpoint = endpoints.find((ep) => ep.id === data.endpoint_id) || endpoints[0];
      const attempt = await replayRequest(data, tracker, endpoint, targetUrl, client, auth);
      summary.attempts.push(attempt);
      summary.attempted += 1;
      if (attempt.succeeded) summary.succeeded += 1;
      else summary.failed += 1;
      if (signal?.aborted) {
        summary.interrupted = true;
        break;
      }
    }
  } catch (err: any) {
    if (signal?.aborted) {
      summary.interrupted = true;
      return summary;
    }
    const msg = err.message || "unknown error";
    ui.warn(`Catch-up failed: ${msg.length > 200 ? msg.slice(0, 200) + "…" : msg}`);
  }

  return summary;
}

export async function runConnectionCatchUp(
  fetcher: CatchUpFetcher,
  tracker: DeliveryTracker,
  endpoints: EndpointData[],
  targetUrl: string,
  client: ApiClient | null,
  auth: AuthMode | MultiAuthMode,
  mode: CatchUpMode,
  signal?: AbortSignal
): Promise<void> {
  try {
    await performConnectionCatchUp(
      fetcher, tracker, endpoints, targetUrl, client, auth, mode, signal
    );
  } catch (error: any) {
    const message = error?.message || "unknown error";
    const summary = message.length > 200 ? `${message.slice(0, 200)}…` : message;
    ui.warn(`Catch-up could not be completed: ${summary}. Live tunnel delivery remains active.`);
  }
}

async function performConnectionCatchUp(
  fetcher: CatchUpFetcher,
  tracker: DeliveryTracker,
  endpoints: EndpointData[],
  targetUrl: string,
  client: ApiClient | null,
  auth: AuthMode | MultiAuthMode,
  mode: CatchUpMode,
  signal?: AbortSignal
): Promise<void> {
  if (!client || auth.mode !== "authenticated") {
    if (mode === "none") {
      ui.info("Catch-up disabled; live tunnel delivery is still active.");
      return;
    }
    await runCatchUp(fetcher, tracker, endpoints, targetUrl, client, auth, undefined, signal);
    return;
  }

  const endpointIds = endpoints.map((endpoint) => endpoint.id);
  let gaps: TunnelGapData[];

  try {
    gaps = await client.getTunnelGaps(endpointIds);
  } catch (error) {
    // Older CatchHook servers do not expose durable gaps. Preserve their
    // existing short-window behavior instead of preventing tunnel startup.
    if (error instanceof ApiError && error.status === 404) {
      if (mode !== "none") {
        await runCatchUp(fetcher, tracker, endpoints, targetUrl, client, auth, undefined, signal);
      }
      return;
    }
    throw error;
  }

  if (signal?.aborted) return;
  gaps = await reconcileDeliveredGaps(client, gaps);

  const unresolved = gaps.reduce((sum, gap) => sum + gap.counts.pending_count + gap.counts.expired_count, 0);
  if (mode === "none") {
    if (unresolved > 0) {
      ui.info(`${unresolved} captured ${unresolved === 1 ? "request needs" : "requests need"} recovery review; catch-up is disabled.`);
    }
    return;
  }

  if (mode === "recent") {
    const recent = await runCatchUp(
      fetcher, tracker, endpoints, targetUrl, client, auth, undefined, signal
    );
    await reportRecentGapProgress(client, gaps, recent);
    if (recent.interrupted) {
      ui.warn(`Catch-up interrupted after ${recent.attempted} request(s); remaining requests stay available for recovery.`);
      return;
    }
    if (unresolved > recent.attempted) {
      ui.info(`${unresolved - recent.attempted} older captured request(s) still need review. Re-run with --catch-up=all to recover them.`);
    }
    return;
  }

  const declinedGapIds = new Set<string>();
  for (const gap of gaps) {
    if (signal?.aborted) return;
    const pending = gap.counts.pending_count + gap.counts.expired_count;
    if (pending === 0) continue;

    const endpoint = endpoints.find((candidate) => candidate.id === gap.endpoint_id) || endpoints[0];
    const approved = mode === "all" || await confirmGapRecovery(gap, targetUrl, signal);
    if (signal?.aborted) return;
    if (!approved) {
      declinedGapIds.add(gap.id);
      await client.reportGapRecovery(gap.id, {
        outcome: "skipped",
        attempted_count: 0,
        succeeded_count: 0,
        failed_count: 0,
      });
      ui.info(`Skipped ${pending} captured request(s) for ${endpoint.name}.`);
      continue;
    }

    const result = await recoverGap(client, gap, tracker, endpoints, targetUrl, auth, signal);
    const outcome = result.interrupted ? "interrupted" : (result.failed === 0 ? "completed" : "partial");
    const updated = await client.reportGapRecovery(gap.id, {
      outcome,
      attempted_count: result.attempted,
      succeeded_count: result.succeeded,
      failed_count: result.failed,
    });

    if (updated.status === "recovered") {
      ui.success(`Recovered ${result.succeeded} request(s) for ${endpoint.name}.`);
    } else {
      ui.warn(`Recovery for ${endpoint.name}: ${result.succeeded} succeeded, ${result.failed} failed, ${updated.counts.pending_count} still pending.`);
    }
    if (result.interrupted) {
      ui.warn(`Catch-up interrupted after ${result.attempted} request(s); remaining requests stay available for recovery.`);
      return;
    }
  }

  // Preserve automatic catch-up for recent requests that do not belong to a
  // durable gap. Requests from a gap the user declined are deliberately left.
  await runCatchUp(
    fetcher,
    tracker,
    endpoints,
    targetUrl,
    client,
    auth,
    (request) => gaps.some((gap) => declinedGapIds.has(gap.id) && requestBelongsToGap(request, gap)),
    signal
  );
}

async function reconcileDeliveredGaps(
  client: ApiClient,
  gaps: TunnelGapData[]
): Promise<TunnelGapData[]> {
  const stillUnresolved: TunnelGapData[] = [];

  for (const gap of gaps) {
    if (gap.counts.pending_count === 0 &&
        gap.counts.expired_count === 0 &&
        gap.counts.retained_count > 0) {
      const updated = await client.reportGapRecovery(gap.id, {
        outcome: "completed",
        attempted_count: 0,
        succeeded_count: 0,
        failed_count: 0,
      });
      if (["open", "reconnected", "partial"].includes(updated.status)) {
        stillUnresolved.push(updated);
      }
    } else {
      stillUnresolved.push(gap);
    }
  }

  return stillUnresolved;
}

async function recoverGap(
  client: ApiClient,
  gap: TunnelGapData,
  tracker: DeliveryTracker,
  endpoints: EndpointData[],
  targetUrl: string,
  auth: AuthMode | MultiAuthMode,
  signal?: AbortSignal
): Promise<CatchUpResult> {
  const result: CatchUpResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    interrupted: false,
    attempts: [],
  };
  let cursor: string | undefined;

  do {
    if (signal?.aborted) {
      result.interrupted = true;
      break;
    }
    const page = await client.getGapRequests(endpoints.map((endpoint) => endpoint.id), gap.id, cursor);
    for (const request of page.data) {
      if (signal?.aborted) {
        result.interrupted = true;
        break;
      }
      if (tracker.forwardedIds.has(request.id)) continue;
      const endpoint = endpoints.find((candidate) => candidate.id === request.endpoint_id) || endpoints[0];
      const attempt = await replayRequest(request, tracker, endpoint, targetUrl, client, auth);
      result.attempts.push(attempt);
      result.attempted += 1;
      if (attempt.succeeded) result.succeeded += 1;
      else result.failed += 1;
      if (signal?.aborted) {
        result.interrupted = true;
        break;
      }
    }
    if (result.interrupted) break;
    cursor = page.meta.next_cursor || undefined;
  } while (cursor);

  return result;
}

async function replayRequest(
  data: MissedWebhookData,
  tracker: DeliveryTracker,
  endpoint: EndpointData,
  targetUrl: string,
  client: ApiClient | null,
  auth: AuthMode | MultiAuthMode
): Promise<CatchUpAttempt> {
  const warning = getReplayWarning(data.detected_provider, data.provider_event_data?.event_type);
  if (warning) ui.warn(`Replay warning (${data.id}): ${warning}`);

  tracker.track(data);
  const result = await forwardToLocalhost(data, targetUrl);
  ui.requestLog(data.method, data.path, result, {
    endpointName: endpoint.name,
    contentType: data.content_type,
    bodySize: data.body_size,
    ipAddress: data.ip_address,
    replay: true,
    detectedProvider: data.detected_provider,
    providerEventType: data.provider_event_data?.event_type,
  });

  try {
    if ("endpointId" in auth) {
      await reportDelivery(client, auth as AuthMode, data, (auth as AuthMode).endpointId, targetUrl, result);
    } else {
      const epAuth: AuthMode = {
        mode: "authenticated",
        token: auth.token,
        endpointId: endpoint.id,
        host: auth.host,
      };
      await reportDelivery(client, epAuth, data, endpoint.id, targetUrl, result);
    }
  } catch (error: any) {
    ui.warn(`Delivery report failed for ${data.id}: ${error?.message || "unknown error"}`);
  }

  const succeeded = result.statusCode >= 200 && result.statusCode <= 299;
  return { id: data.id, endpointId: endpoint.id, requestedAt: data.requested_at, succeeded };
}

async function confirmGapRecovery(
  gap: TunnelGapData,
  targetUrl: string,
  signal?: AbortSignal
): Promise<boolean> {
  const pending = gap.counts.pending_count + gap.counts.expired_count;
  ui.info(`CatchHook captured ${pending} request(s) while this tunnel was disconnected (${formatDate(gap.started_at)} - ${formatDate(gap.reconnected_at || gap.detected_at)}).`);
  if (gap.target_url && gap.target_url !== targetUrl) {
    ui.info(`Historical target: ${gap.target_url}; current target: ${targetUrl}. Recovery uses the current target.`);
  }
  return ui.confirm(`Replay ${pending} captured request(s) to ${targetUrl} now?`, signal);
}

async function reportRecentGapProgress(
  client: ApiClient,
  gaps: TunnelGapData[],
  result: CatchUpResult
): Promise<void> {
  for (const gap of gaps) {
    const attempts = result.attempts.filter((attempt) =>
      attempt.endpointId === gap.endpoint_id && requestTimeBelongsToGap(attempt.requestedAt, gap)
    );
    if (attempts.length === 0) continue;

    const succeeded = attempts.filter((attempt) => attempt.succeeded).length;
    await client.reportGapRecovery(gap.id, {
      outcome: result.interrupted ? "interrupted" : (succeeded === attempts.length ? "completed" : "partial"),
      attempted_count: attempts.length,
      succeeded_count: succeeded,
      failed_count: attempts.length - succeeded,
    });
  }
}

function requestBelongsToGap(request: MissedWebhookData, gap: TunnelGapData): boolean {
  return request.endpoint_id === gap.endpoint_id && requestTimeBelongsToGap(request.requested_at, gap);
}

function requestTimeBelongsToGap(requestedAt: string, gap: TunnelGapData): boolean {
  const time = new Date(requestedAt).getTime();
  const start = new Date(gap.started_at).getTime();
  const end = gap.reconnected_at
    ? new Date(gap.reconnected_at).getTime()
    : Number.POSITIVE_INFINITY;
  return time > start && time <= end;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function reportDelivery(
  client: ApiClient | null,
  auth: AuthMode,
  data: WebhookData,
  endpointId: string,
  targetUrl: string,
  result: ForwardResult
): Promise<void> {
  if (client && auth.mode === "authenticated") {
    return client.reportDelivery({
      webhook_request_id: data.id,
      endpoint_id: endpointId,
      status_code: result.statusCode,
      response_time_ms: result.responseTimeMs,
      target_url: targetUrl,
      response_message: result.error || result.statusText || undefined,
      failure_category: result.failureCategory || undefined,
    });
  } else if (auth.mode === "anonymous") {
    return reportAnonymousDelivery(
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
    );
  }

  return Promise.resolve();
}

export function setupShutdown(
  disconnect: () => void,
  finishInFlight?: () => Promise<void>
): void {
  let shuttingDown = false;
  process.once("SIGINT", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log();
    ui.info("Disconnecting...");
    if (finishInFlight) {
      try {
        await finishInFlight();
      } catch (error: any) {
        ui.warn(`Could not finish recovery reporting: ${error?.message || "unknown error"}`);
      }
    }
    disconnect();
    process.exit(0);
  });
}
