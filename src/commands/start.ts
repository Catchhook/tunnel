import { getStoredHost, ensureAuthenticatedToken } from "../lib/config.js";
import { getHost, getBaseUrl } from "../lib/constants.js";
import { ApiClient, type EndpointData } from "../lib/api-client.js";
import type { AuthMode } from "../lib/cable-client.js";
import { loginCommand } from "./login.js";
import { resolveEndpoints } from "../lib/endpoint-resolver.js";
import { runSingleTunnel, runMultiTunnel } from "../lib/tunnel-session.js";
import * as ui from "../lib/ui.js";

export interface StartOptions {
  port?: string;
  endpoint?: string[];
  key?: string;
  new?: boolean;
  all?: boolean;
  host?: string;
  token?: string;
  authCode?: string;
  browser?: boolean;
}

export async function startCommand(
  targetArg: string | undefined,
  options: StartOptions
): Promise<void> {
  const host = options.host || getStoredHost() || getHost();

  let targetUrl: string;
  const portOrUrl = targetArg || options.port || "3000";

  if (portOrUrl.startsWith("http")) {
    targetUrl = portOrUrl;
  } else {
    targetUrl = `http://localhost:${portOrUrl}`;
  }

  if (options.key) {
    const endpointId = targetArg && !targetArg.startsWith("http") && isNaN(Number(targetArg))
      ? targetArg
      : options.endpoint?.[0];

    if (!endpointId) {
      ui.error("Endpoint ID is required for anonymous tunnel. Usage: catchhook-tunnel <endpoint_id> --key <tunnel_key> --port 3000");
      process.exit(1);
    }

    if (targetArg && !targetArg.startsWith("http") && isNaN(Number(targetArg))) {
      targetUrl = `http://localhost:${options.port || "3000"}`;
    }

    await startAnonymousTunnel(endpointId, options.key, targetUrl, host);
    return;
  }

  if (!options.all && !options.new && (!options.endpoint || options.endpoint.length === 0)) {
    ui.error("For authenticated tunnels, pass --endpoint <id>, --all, or --new.");
    process.exit(1);
  }

  const { token, identity } = await ensureAuthenticatedToken(host, options, loginCommand);
  const client = new ApiClient(token, host);
  const endpoints = await resolveEndpoints(client, options, targetUrl);
  const baseUrl = getBaseUrl(host);

  if (endpoints.length === 1) {
    const endpoint = endpoints[0];
    ui.connectionInfo({
      mode: "authenticated",
      email: identity.user.email,
      accountName: identity.account.name,
      endpointName: endpoint.name,
      endpointId: endpoint.id,
      webhookUrl: endpoint.webhook_url,
      targetUrl,
      dashboardUrl: `${baseUrl}/endpoints/${endpoint.id}`,
    });

    const auth: AuthMode = { mode: "authenticated", token, endpointId: endpoint.id, host };
    const catchUpFetcher = (epIds: string[]) => client.getUndeliveredRequests(epIds, 120);
    await runSingleTunnel(auth, targetUrl, client, endpoint, catchUpFetcher);
  } else {
    ui.connectionInfo({
      mode: "authenticated",
      email: identity.user.email,
      accountName: identity.account.name,
      targetUrl,
      dashboardUrl: `${baseUrl}/endpoints`,
      endpoints: endpoints.map((ep) => ({
        name: ep.name,
        id: ep.id,
        webhookUrl: ep.webhook_url,
      })),
    });

    const catchUpFetcher = (epIds: string[]) => client.getUndeliveredRequests(epIds, 120);
    await runMultiTunnel(token, host, targetUrl, client, endpoints, catchUpFetcher);
  }
}

async function startAnonymousTunnel(
  endpointId: string,
  tunnelKey: string,
  targetUrl: string,
  host: string
): Promise<void> {
  const auth: AuthMode = { mode: "anonymous", tunnelKey, endpointId, host };
  const baseUrl = getBaseUrl(host);

  const webhookUrlObj = new URL(baseUrl);
  webhookUrlObj.hostname = `temp.${webhookUrlObj.hostname}`;
  webhookUrlObj.pathname = `/hooks/${endpointId}`;

  ui.connectionInfo({
    mode: "anonymous",
    endpointId,
    webhookUrl: webhookUrlObj.toString().replace(/\/$/, ""),
    targetUrl,
  });

  const { getAnonymousMissedRequests } = await import("../lib/api-client.js");
  const catchUpFetcher = (_epIds: string[]) => {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    return getAnonymousMissedRequests(tunnelKey, since, host);
  };

  await runSingleTunnel(
    auth,
    targetUrl,
    null,
    { id: endpointId, name: endpointId } as EndpointData,
    catchUpFetcher
  );
}
