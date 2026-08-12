import {
  ApiClient,
  ApiError,
  reportAnonymousDelivery,
  type EndpointData,
  type MissedWebhookData,
  type TunnelGapData,
} from "./api-client.js";
import { connectTunnel, connectMultiTunnel, type AuthMode, type MultiAuthMode, type TunnelReplayCommand, type WebhookData } from "./cable-client.js";
import { forwardToLocalhost, type ForwardResult } from "./forwarder.js";
import { getReplayWarning } from "./providers.js";
import * as ui from "./ui.js";
import { randomUUID } from "node:crypto";
import type { TicketResponse } from "./api-client.js";
import { claimReplayCommand } from "./config.js";

interface DeliveryProtocolContext {
  protocol?: TicketResponse["tunnel_protocol"];
  tunnelClientId?: string;
  tunnelClientCredential?: string;
}

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

const REPLAY_RESULT_RETRY_INITIAL_MS = 100;
const REPLAY_RESULT_RETRY_MAX_MS = 2_000;

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

  const protocolContext: DeliveryProtocolContext = {};
  let connection: Awaited<ReturnType<typeof connectTunnel>> | undefined;
  connection = await connectTunnel(auth, {
    onConnected() {
      refreshProtocolContext(protocolContext, connection);
      if (catchUpFetcher && !catchUpInFlight) {
        catchUpInFlight = runConnectionCatchUp(
          catchUpFetcher, tracker, [endpoint], targetUrl, client, auth, catchUpMode,
          catchUpAbort.signal, protocolContext
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
      const attemptId = randomUUID();
      const result: ForwardResult = await forwardDelivery(data, targetUrl, protocolContext);
      ui.requestLog(data.method, data.path, result, {
        endpointName: endpoint.name,
        contentType: data.content_type,
        bodySize: data.body_size,
        ipAddress: data.ip_address,
        detectedProvider: data.detected_provider,
        providerEventType: data.provider_event_data?.event_type,
      });

      void reportDelivery(client, auth, data, endpoint.id, targetUrl, result, attemptId, protocolContext).catch(() => {});
    },
    async onTunnelReplay(command: TunnelReplayCommand) {
      if (!client || auth.mode !== "authenticated") return;
      await executeTunnelReplay(command, targetUrl, client);
    },
  }, targetUrl);
  refreshProtocolContext(protocolContext, connection);

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
  client: ApiClient | null,
  endpoints: EndpointData[],
  catchUpFetcher?: CatchUpFetcher,
  catchUpMode: CatchUpMode = defaultCatchUpMode()
): Promise<void> {
  let wasConnected = false;
  const tracker = createDeliveryTracker();
  const catchUpAbort = new AbortController();
  let catchUpInFlight: Promise<void> | null = null;

  const multiAuth: MultiAuthMode = { mode: "authenticated", token, host };

  const protocolContext: DeliveryProtocolContext = {};
  let connection: Awaited<ReturnType<typeof connectMultiTunnel>> | undefined;
  connection = await connectMultiTunnel(multiAuth, {
    onConnected() {
      refreshProtocolContext(protocolContext, connection);
      if (catchUpFetcher && !catchUpInFlight) {
        catchUpInFlight = runConnectionCatchUp(
          catchUpFetcher, tracker, endpoints, targetUrl, client, multiAuth, catchUpMode,
          catchUpAbort.signal, protocolContext
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
        const attemptId = randomUUID();
        const result: ForwardResult = await forwardDelivery(data, targetUrl, protocolContext);
        ui.requestLog(data.method, data.path, result, {
          endpointName: endpoint.name,
          contentType: data.content_type,
          bodySize: data.body_size,
          ipAddress: data.ip_address,
          detectedProvider: data.detected_provider,
          providerEventType: data.provider_event_data?.event_type,
        });

        const auth: AuthMode = { mode: "authenticated", token, endpointId: endpoint.id, host };
        void reportDelivery(client, auth, data, endpoint.id, targetUrl, result, attemptId, protocolContext).catch(() => {});
      },
      onRejected() {
        ui.error(`Tunnel subscription rejected for endpoint "${endpoint.name}" (${endpoint.id}). Check account limits.`);
      },
      async onTunnelReplay(command: TunnelReplayCommand) {
        if (!client) return;
        await executeTunnelReplay(command, targetUrl, client);
      },
    });
  }
  refreshProtocolContext(protocolContext, connection);

  setupShutdown(connection.disconnect, async () => {
    const pending = catchUpInFlight;
    catchUpAbort.abort();
    if (pending) await pending;
  });
  await new Promise(() => {});
}

const MAX_TRACKED_IDS = 500;

function refreshProtocolContext(
  context: DeliveryProtocolContext,
  connection: { tunnelProtocol?: TicketResponse["tunnel_protocol"]; tunnelClientId?: string; tunnelClientCredential?: string } | undefined
): void {
  if (!connection) return;

  context.protocol = connection.tunnelProtocol;
  context.tunnelClientId = connection.tunnelClientId;
  context.tunnelClientCredential = connection.tunnelClientCredential;
}

function forwardDelivery(
  data: WebhookData | MissedWebhookData,
  targetUrl: string,
  context: DeliveryProtocolContext
): Promise<ForwardResult> {
  const limit = context.protocol?.evidence_body_limit;
  if (!context.protocol) {
    return forwardToLocalhost(data, targetUrl, null);
  }
  if (context.protocol?.delivery_report_version === 2) {
    return forwardToLocalhost(data, targetUrl, limit, 30_000, "manual");
  }

  return forwardToLocalhost(data, targetUrl, null);
}

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
  signal?: AbortSignal,
  context: DeliveryProtocolContext = {}
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
    const missed = await retryCatchUpRequest(
      () => fetcher(endpointIds),
      signal,
      "request lookup"
    );
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
      const attempt = await replayRequest(data, tracker, endpoint, targetUrl, client, auth, context, signal);
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
  signal?: AbortSignal,
  context: DeliveryProtocolContext = {}
): Promise<void> {
  try {
    await performConnectionCatchUp(
      fetcher, tracker, endpoints, targetUrl, client, auth, mode, signal, context
    );
  } catch (error: any) {
    if (signal?.aborted) return;
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
  signal?: AbortSignal,
  context: DeliveryProtocolContext = {}
): Promise<void> {
  if (!client || auth.mode !== "authenticated") {
    if (mode === "none") {
      ui.info("Catch-up disabled; live tunnel delivery is still active.");
      return;
    }
    await runCatchUp(fetcher, tracker, endpoints, targetUrl, client, auth, undefined, signal, context);
    return;
  }

  const endpointIds = endpoints.map((endpoint) => endpoint.id);
  let gaps: TunnelGapData[];

  try {
    gaps = await retryCatchUpRequest(
      () => client.getTunnelGaps(endpointIds),
      signal,
      "gap lookup"
    );
  } catch (error) {
    // Older CatchHook servers do not expose durable gaps. Preserve their
    // existing short-window behavior instead of preventing tunnel startup.
    if (error instanceof ApiError && error.status === 404) {
      if (mode !== "none") {
        await runCatchUp(fetcher, tracker, endpoints, targetUrl, client, auth, undefined, signal, context);
      }
      return;
    }
    throw error;
  }

  if (signal?.aborted) return;
  gaps = await reconcileDeliveredGaps(client, gaps, signal);

  const unresolved = gaps.reduce((sum, gap) => sum + gap.counts.pending_count + gap.counts.expired_count, 0);
  if (mode === "none") {
    if (unresolved > 0) {
      ui.info(`${unresolved} captured ${unresolved === 1 ? "request needs" : "requests need"} recovery review; catch-up is disabled.`);
    }
    return;
  }

  if (mode === "recent") {
    const recent = await runCatchUp(
      fetcher, tracker, endpoints, targetUrl, client, auth, undefined, signal, context
    );
    await reportRecentGapProgress(client, gaps, recent, signal);
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
      await retryCatchUpRequest(
        () => client.reportGapRecovery(gap.id, {
          outcome: "skipped",
          attempted_count: 0,
          succeeded_count: 0,
          failed_count: 0,
        }),
        signal,
        "gap update"
      );
      ui.info(`Skipped ${pending} captured request(s) for ${endpoint.name}.`);
      continue;
    }

    const result = await recoverGap(client, gap, tracker, endpoints, targetUrl, auth, signal, context);
    const outcome = result.interrupted ? "interrupted" : (result.failed === 0 ? "completed" : "partial");
    const updated = await retryCatchUpRequest(
      () => client.reportGapRecovery(gap.id, {
        outcome,
        attempted_count: result.attempted,
        succeeded_count: result.succeeded,
        failed_count: result.failed,
      }),
      signal,
      "gap update"
    );

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
    signal,
    context
  );
}

async function reconcileDeliveredGaps(
  client: ApiClient,
  gaps: TunnelGapData[],
  signal?: AbortSignal
): Promise<TunnelGapData[]> {
  const stillUnresolved: TunnelGapData[] = [];

  for (const gap of gaps) {
    if (gap.counts.pending_count === 0 &&
        gap.counts.expired_count === 0 &&
        gap.counts.retained_count > 0) {
      const updated = await retryCatchUpRequest(
        () => client.reportGapRecovery(gap.id, {
          outcome: "completed",
          attempted_count: 0,
          succeeded_count: 0,
          failed_count: 0,
        }),
        signal,
        "gap reconciliation"
      );
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
  signal?: AbortSignal,
  context: DeliveryProtocolContext = {}
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
    const page = await retryCatchUpRequest(
      () => client.getGapRequests(endpoints.map((endpoint) => endpoint.id), gap.id, cursor),
      signal,
      "gap page"
    );
    for (const request of page.data) {
      if (signal?.aborted) {
        result.interrupted = true;
        break;
      }
      if (tracker.forwardedIds.has(request.id)) continue;
      const endpoint = endpoints.find((candidate) => candidate.id === request.endpoint_id) || endpoints[0];
      const attempt = await replayRequest(request, tracker, endpoint, targetUrl, client, auth, context, signal);
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
  auth: AuthMode | MultiAuthMode,
  context: DeliveryProtocolContext = {},
  signal?: AbortSignal
): Promise<CatchUpAttempt> {
  const warning = getReplayWarning(data.detected_provider, data.provider_event_data?.event_type);
  if (warning) ui.warn(`Replay warning (${data.id}): ${warning}`);

  tracker.track(data);
  const result = await forwardDelivery(data, targetUrl, context);
  ui.requestLog(data.method, data.path, result, {
    endpointName: endpoint.name,
    contentType: data.content_type,
    bodySize: data.body_size,
    ipAddress: data.ip_address,
    replay: true,
    detectedProvider: data.detected_provider,
    providerEventType: data.provider_event_data?.event_type,
  });

  const attemptId = randomUUID();
  let reportPersisted = false;
  while (true) {
    try {
      if ("endpointId" in auth) {
        await reportDelivery(client, auth as AuthMode, data, (auth as AuthMode).endpointId, targetUrl, result, attemptId, context);
      } else {
        const epAuth: AuthMode = {
          mode: "authenticated",
          token: auth.token,
          endpointId: endpoint.id,
          host: auth.host,
        };
        await reportDelivery(client, epAuth, data, endpoint.id, targetUrl, result, attemptId, context);
      }
      reportPersisted = true;
      break;
    } catch (error: any) {
      if (error instanceof ApiError && error.status === 429) {
        const retryAfterMs = error.retryAfterMs ?? 1_000;
        ui.warn(`Catch-up report rate limited; pausing before retrying ${data.id}.`);
        if (!await waitForRetry(retryAfterMs, signal)) break;
        continue;
      }
      ui.warn(`Delivery report failed for ${data.id}: ${error?.message || "unknown error"}`);
      break;
    }
  }

  const succeeded = reportPersisted && result.statusCode >= 200 && result.statusCode <= 299;
  return { id: data.id, endpointId: endpoint.id, requestedAt: data.requested_at, succeeded };
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, Math.max(0, delayMs));
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function retryCatchUpRequest<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  description: string
): Promise<T> {
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429) throw error;

      const retryAfterMs = error.retryAfterMs ?? 1_000;
      const retryAfterSeconds = Math.max(0, Math.ceil(retryAfterMs / 1_000));
      ui.warn(`Catch-up ${description} rate limited; resuming in ${retryAfterSeconds} second(s).`);
      if (!await waitForRetry(retryAfterMs, signal)) throw error;
    }
  }
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
  result: CatchUpResult,
  signal?: AbortSignal
): Promise<void> {
  for (const gap of gaps) {
    const attempts = result.attempts.filter((attempt) =>
      attempt.endpointId === gap.endpoint_id && requestTimeBelongsToGap(attempt.requestedAt, gap)
    );
    if (attempts.length === 0) continue;

    const succeeded = attempts.filter((attempt) => attempt.succeeded).length;
    await retryCatchUpRequest(
      () => client.reportGapRecovery(gap.id, {
        outcome: result.interrupted ? "interrupted" : (succeeded === attempts.length ? "completed" : "partial"),
        attempted_count: attempts.length,
        succeeded_count: succeeded,
        failed_count: attempts.length - succeeded,
      }),
      signal,
      "gap update"
    );
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
  result: ForwardResult,
  attemptId: string,
  context: DeliveryProtocolContext
): Promise<void> {
  const v2 = context.protocol?.delivery_report_version === 2;
  const evidence = result.evidence;
  const v2Payload = v2 ? {
    report_version: 2,
    delivery_attempt_id: attemptId,
    tunnel_client_id: context.tunnelClientId,
    tunnel_client_credential: context.tunnelClientCredential,
    resolved_url: result.resolvedUrl,
    content_type: evidence.contentType,
    response_headers: evidence.headers,
    body: evidence.body,
    body_encoding: evidence.bodyEncoding,
    declared_content_length: evidence.declaredContentLength,
    decoded_bytes_observed: evidence.decodedBytesObserved,
    retained_bytes: evidence.retainedBytes,
    capture_complete: evidence.captureComplete,
    truncation_reason: evidence.truncationReason,
  } : {};
  if (client && auth.mode === "authenticated") {
    return client.reportDelivery({
      webhook_request_id: data.id,
      endpoint_id: endpointId,
      status_code: result.statusCode,
      response_time_ms: result.responseTimeMs,
      target_url: targetUrl,
      response_message: result.error || result.statusText || undefined,
      failure_category: result.failureCategory || undefined,
      ...v2Payload,
    }).then(() => undefined);
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
        ...v2Payload,
      },
      auth.host
    );
  }

  return Promise.resolve();
}

export async function executeTunnelReplay(
  command: TunnelReplayCommand,
  targetUrl: string,
  client: ApiClient
): Promise<void> {
  const expiry = new Date(command.expires_at).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
  if (!claimReplayCommand(command.command_id, command.expires_at)) return;

  let result: ForwardResult;
  let requestMayHaveBeenSent = false;
  try {
    const target = new URL(targetUrl);
    const commandUrl = new URL(command.url);
    if (!replayTargetCompatible(commandUrl, target)) {
      throw new Error("Replay command target does not match this tunnel client");
    }
    const data: WebhookData = {
      type: "tunnel_replay_command",
      id: command.replay_case_run_id,
      method: command.method,
      path: null,
      headers: command.headers,
      body: command.body_base64 ? Buffer.from(command.body_base64, "base64") : null,
      body_encoding: "base64",
      body_size: command.body_base64 ? Buffer.from(command.body_base64, "base64").length : 0,
      query_parameters: {},
      content_type: command.headers["Content-Type"] || command.headers["content-type"] || null,
      ip_address: null,
      requested_at: new Date().toISOString(),
      detected_provider: null,
      provider_event_data: null,
    };
    const remainingMs = expiry - Date.now();
    if (remainingMs <= 0) throw new Error("Replay command expired before local delivery");
    const requestedTimeout = Number(command.timeout_ms);
    const timeoutMs = Math.min(
      Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 30_000,
      remainingMs
    );
    result = await forwardToLocalhost(data, command.url, command.evidence_body_limit, timeoutMs, "manual");
    requestMayHaveBeenSent = result.statusCode > 0 || ![
      "connection_refused", "dns_error", "tls_error",
    ].includes(result.failureCategory || "");
  } catch (error: any) {
    result = {
      statusCode: 0,
      statusText: "Blocked",
      responseTimeMs: 0,
      error: error?.message || "Replay command was rejected",
      failureCategory: "unknown_error",
      resolvedUrl: command.url,
      evidence: {
        contentType: null, headers: {}, body: null, bodyEncoding: null,
        declaredContentLength: null, decodedBytesObserved: 0, retainedBytes: 0,
        captureComplete: false, truncationReason: null,
      },
    };
  }

  const evidence = result.evidence;
  const replayResult = {
    result_token: command.result_token,
    command_id: command.command_id,
    status_code: result.statusCode,
    response_time_ms: result.responseTimeMs,
    response_message: result.statusText,
    error: result.error,
    failure_category: result.failureCategory,
    request_may_have_been_sent: requestMayHaveBeenSent,
    content_type: evidence.contentType,
    response_headers: evidence.headers,
    body: evidence.body,
    body_encoding: evidence.bodyEncoding,
    decoded_bytes_observed: evidence.decodedBytesObserved,
    capture_complete: evidence.captureComplete,
  };
  await reportTunnelReplayResultWithRetry(client, replayResult, expiry);
}

function replayTargetCompatible(commandUrl: URL, target: URL): boolean {
  if (target.protocol !== commandUrl.protocol || target.hostname !== commandUrl.hostname || target.port !== commandUrl.port) {
    return false;
  }

  const commandPath = safelyDecodedPath(commandUrl.pathname);
  const targetPath = safelyDecodedPath(target.pathname);
  if (commandPath == null || targetPath == null) return false;

  const basePath = targetPath.replace(/\/+$/, "");
  return basePath === "" || commandPath === basePath || commandPath.startsWith(`${basePath}/`);
}

function safelyDecodedPath(path: string): string | null {
  let decoded = path;
  try {
    while (true) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }

  return decoded.split("/").some((segment) => segment === "." || segment === "..") ? null : decoded;
}

export async function reportTunnelReplayResultWithRetry(
  client: ApiClient,
  result: Record<string, unknown>,
  expiresAt: number
): Promise<void> {
  let delay = REPLAY_RESULT_RETRY_INITIAL_MS;

  while (Date.now() < expiresAt) {
    try {
      await client.reportTunnelReplayResult(result);
      return;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        ui.warn(`Replay result was rejected and will not be retried: ${error.message}`);
        return;
      }

      const remaining = expiresAt - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(delay, remaining));
      delay = Math.min(delay * 2, REPLAY_RESULT_RETRY_MAX_MS);
    }
  }

  ui.warn("Replay result could not be reported before the command deadline.");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
