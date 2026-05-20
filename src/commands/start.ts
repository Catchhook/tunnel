import { randomBytes } from "node:crypto";
import { getStoredHost, ensureAuthenticatedToken } from "../lib/config.js";
import { getHost, getBaseUrl } from "../lib/constants.js";
import { ApiClient, createAnonymousSignatureConfig, type EndpointData } from "../lib/api-client.js";
import type { AuthMode } from "../lib/cable-client.js";
import { loginCommand } from "./login.js";
import { resolveEndpoints } from "../lib/endpoint-resolver.js";
import { runSingleTunnel, runMultiTunnel } from "../lib/tunnel-session.js";
import { getProviderPreset, resolveTargetUrl, VALID_PROVIDERS } from "../lib/providers.js";
import * as ui from "../lib/ui.js";

export interface StartOptions {
  port?: string;
  endpoint?: string[];
  key?: string;
  new?: boolean;
  all?: boolean;
  provider?: string;
  host?: string;
  token?: string;
  authCode?: string;
  browser?: boolean;
}

function generateSecret(): string {
  return `chsec_${randomBytes(24).toString("hex")}`;
}

export async function startCommand(
  targetArg: string | undefined,
  options: StartOptions
): Promise<void> {
  const host = options.host || getStoredHost() || getHost();

  // Validate --provider
  const providerPreset = options.provider
    ? getProviderPreset(options.provider)
    : undefined;

  if (options.provider && !providerPreset) {
    ui.error(
      `Unknown provider "${options.provider}". Valid providers: ${VALID_PROVIDERS.join(", ")}`
    );
    process.exit(1);
  }

  if (options.provider && options.all) {
    ui.error("--provider is not compatible with --all.");
    process.exit(1);
  }

  if (options.provider && options.endpoint && options.endpoint.length > 1) {
    ui.error("--provider only works with a single --endpoint.");
    process.exit(1);
  }

  // --provider without --endpoint implies --new
  if (providerPreset && !options.endpoint?.length && !options.new && !options.key) {
    options.new = true;
  }

  const targetUrl = resolveTargetUrl(targetArg, options.port, providerPreset);

  if (options.key) {
    const endpointId = targetArg && !targetArg.startsWith("http") && isNaN(Number(targetArg))
      ? targetArg
      : options.endpoint?.[0];

    if (!endpointId) {
      ui.error("Endpoint ID is required for anonymous tunnel. Usage: catchhook-tunnel <endpoint_id> --key <tunnel_key> --port 3000");
      process.exit(1);
    }

    const isEndpointId = targetArg && !targetArg.startsWith("http") && isNaN(Number(targetArg));
    const forwardTarget = isEndpointId
      ? resolveTargetUrl(undefined, options.port || "3000", providerPreset)
      : targetUrl;

    if (providerPreset) {
      const secret = generateSecret();
      try {
        const result = await createAnonymousSignatureConfig(
          options.key,
          { provider: providerPreset.name, secret, enabled: true },
          host
        );
        if (!result.conflict) {
          ui.providerSetupInfo({
            providerName: providerPreset.displayName,
            secret,
            targetUrl: forwardTarget,
            setupInstructions: providerPreset.setupInstructions,
            suggestedEvents: providerPreset.suggestedEvents,
          });
        }
      } catch (err: any) {
        ui.warn(`Could not create signature config: ${err.message}`);
      }
    }

    await startAnonymousTunnel(endpointId, options.key, forwardTarget, host);
    return;
  }

  if (!options.all && !options.new && (!options.endpoint || options.endpoint.length === 0)) {
    ui.error("For authenticated tunnels, pass --endpoint <id>, --all, or --new.");
    process.exit(1);
  }

  const { token, identity } = await ensureAuthenticatedToken(host, options, loginCommand);
  const client = new ApiClient(token, host);

  // Provider + authenticated flow
  if (providerPreset && options.new) {
    const endpointName = `${providerPreset.displayName} Webhook`;
    const { data: endpoint } = await client.createEndpoint(endpointName, {
      provider: providerPreset.name,
      provider_config: { expected_events: providerPreset.suggestedEvents },
    });

    const secret = generateSecret();
    await client.createSignatureConfig(endpoint.id, {
      provider: providerPreset.name,
      secret,
      enabled: true,
    });

    const baseUrl = getBaseUrl(host);
    ui.providerSetupInfo({
      providerName: providerPreset.displayName,
      secret,
      targetUrl,
      webhookUrl: endpoint.webhook_url,
      endpointId: endpoint.id,
      dashboardUrl: `${baseUrl}/endpoints/${endpoint.id}`,
      setupInstructions: providerPreset.setupInstructions,
      suggestedEvents: providerPreset.suggestedEvents,
    });

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
    return;
  }

  if (providerPreset && options.endpoint?.length) {
    // Using existing endpoint with --provider: create sig config, prompt on conflict
    const endpoints = await resolveEndpoints(client, options, targetUrl);
    if (endpoints.length === 1) {
      const endpoint = endpoints[0];
      const secret = generateSecret();
      const result = await client.createSignatureConfig(endpoint.id, {
        provider: providerPreset.name,
        secret,
        enabled: true,
      });

      const baseUrl = getBaseUrl(host);
      if (result.conflict) {
        const overwrite = await ui.confirm(
          `Signature config for ${providerPreset.displayName} already exists on this endpoint. Overwrite with a new secret?`
        );
        if (overwrite) {
          const forceResult = await client.createSignatureConfig(
            endpoint.id,
            { provider: providerPreset.name, secret, enabled: true },
            true
          );
          if (!forceResult.conflict) {
            ui.providerSetupInfo({
              providerName: providerPreset.displayName,
              secret,
              targetUrl,
              webhookUrl: endpoint.webhook_url,
              endpointId: endpoint.id,
              dashboardUrl: `${baseUrl}/endpoints/${endpoint.id}`,
              setupInstructions: providerPreset.setupInstructions,
              suggestedEvents: providerPreset.suggestedEvents,
            });
          }
        } else {
          ui.info(`Keeping existing ${providerPreset.displayName} signature config.`);
        }
      } else {
        ui.providerSetupInfo({
          providerName: providerPreset.displayName,
          secret,
          targetUrl,
          webhookUrl: endpoint.webhook_url,
          endpointId: endpoint.id,
          dashboardUrl: `${baseUrl}/endpoints/${endpoint.id}`,
          setupInstructions: providerPreset.setupInstructions,
          suggestedEvents: providerPreset.suggestedEvents,
        });
      }
    }
  }

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
