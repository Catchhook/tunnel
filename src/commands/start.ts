import readline from "node:readline";
import { getStoredToken, getStoredHost } from "../lib/config.js";
import { getHost, getBaseUrl } from "../lib/constants.js";
import { ApiClient, reportAnonymousDelivery, type EndpointData } from "../lib/api-client.js";
import { connectTunnel, connectMultiTunnel, type AuthMode, type MultiAuthMode, type WebhookData } from "../lib/cable-client.js";
import { forwardToLocalhost, type ForwardResult } from "../lib/forwarder.js";
import * as ui from "../lib/ui.js";

interface StartOptions {
  port?: string;
  endpoint?: string[];
  key?: string;
  new?: boolean;
  all?: boolean;
  host?: string;
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

  // Anonymous mode (--key flag provided) -- single endpoint only
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

  // Authenticated mode
  const token = getStoredToken();
  if (!token) {
    ui.error("Not authenticated. Run `catchhook-tunnel login` first, or use --key for anonymous tunneling.");
    process.exit(1);
  }

  const client = new ApiClient(token, host);

  let authInfo;
  try {
    authInfo = await client.verify();
  } catch {
    ui.error("Authentication failed. Run `catchhook-tunnel login` to re-authenticate.");
    process.exit(1);
  }

  // Resolve which endpoints to tunnel
  let endpoints: EndpointData[];

  if (options.all) {
    const { data: allEndpoints } = await client.listEndpoints();
    if (allEndpoints.length === 0) {
      ui.error("No endpoints found in this account.");
      process.exit(1);
    }
    endpoints = allEndpoints;
  } else if (options.endpoint && options.endpoint.length > 0) {
    const { data: allEndpoints } = await client.listEndpoints();
    const seen = new Set<string>();
    endpoints = [];
    for (const idArg of options.endpoint) {
      if (seen.has(idArg)) {
        ui.warn(`Duplicate endpoint "${idArg}" ignored.`);
        continue;
      }
      seen.add(idArg);

      const found = allEndpoints.find(
        (ep) => ep.id === idArg || ep.custom_id === idArg
      );
      if (!found) {
        ui.error(`Endpoint "${idArg}" not found.`);
        process.exit(1);
      }
      endpoints.push(found);
    }
  } else if (options.new) {
    const name = `Tunnel -> ${targetUrl}`;
    const { data: newEp } = await client.createEndpoint(name);
    ui.success(`Created endpoint "${newEp.name}" (${newEp.id})`);
    endpoints = [newEp];
  } else {
    const selected = await selectEndpoint(client, targetUrl);
    endpoints = [selected];
  }

  const baseUrl = getBaseUrl(host);

  if (endpoints.length === 1) {
    const endpoint = endpoints[0];
    ui.connectionInfo({
      mode: "authenticated",
      email: authInfo.data.user.email,
      accountName: authInfo.data.account.name,
      endpointName: endpoint.name,
      endpointId: endpoint.id,
      webhookUrl: endpoint.webhook_url,
      targetUrl,
      dashboardUrl: `${baseUrl}/endpoints/${endpoint.id}`,
    });

    const auth: AuthMode = {
      mode: "authenticated",
      token,
      endpointId: endpoint.id,
      host,
    };
    await runSingleTunnel(auth, targetUrl, client, endpoint);
  } else {
    ui.connectionInfo({
      mode: "authenticated",
      email: authInfo.data.user.email,
      accountName: authInfo.data.account.name,
      targetUrl,
      dashboardUrl: `${baseUrl}/endpoints`,
      endpoints: endpoints.map((ep) => ({
        name: ep.name,
        id: ep.id,
        webhookUrl: ep.webhook_url,
      })),
    });

    await runMultiTunnel(token, host, targetUrl, client, endpoints);
  }
}

async function startAnonymousTunnel(
  endpointId: string,
  tunnelKey: string,
  targetUrl: string,
  host: string
): Promise<void> {
  const auth: AuthMode = {
    mode: "anonymous",
    tunnelKey,
    endpointId,
    host,
  };

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

  await runSingleTunnel(auth, targetUrl, null, { id: endpointId, name: endpointId } as EndpointData);
}

async function runSingleTunnel(
  auth: AuthMode,
  targetUrl: string,
  client: ApiClient | null,
  endpoint: EndpointData
): Promise<void> {
  let wasConnected = false;
  const connection = await connectTunnel(auth, {
    onConnected() {
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
      const result: ForwardResult = await forwardToLocalhost(data, targetUrl);
      ui.requestLog(data.method, data.path, result, {
        endpointName: endpoint.name,
        contentType: data.content_type,
        bodySize: data.body_size,
        ipAddress: data.ip_address,
      });

      reportDelivery(client, auth, data, endpoint.id, targetUrl, result);
    },
  }, targetUrl);

  setupShutdown(connection.disconnect);
  await new Promise(() => {});
}

async function runMultiTunnel(
  token: string,
  host: string,
  targetUrl: string,
  client: ApiClient,
  endpoints: EndpointData[]
): Promise<void> {
  let wasConnected = false;

  const multiAuth: MultiAuthMode = { mode: "authenticated", token, host };

  const connection = await connectMultiTunnel(multiAuth, {
    onConnected() {
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
        const result: ForwardResult = await forwardToLocalhost(data, targetUrl);
        ui.requestLog(data.method, data.path, result, {
          endpointName: endpoint.name,
          contentType: data.content_type,
          bodySize: data.body_size,
          ipAddress: data.ip_address,
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
      },
      auth.host
    ).catch(() => {});
  }
}

function setupShutdown(disconnect: () => void): void {
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

async function selectEndpoint(
  client: ApiClient,
  targetUrl: string
): Promise<EndpointData> {
  const { data: endpoints } = await client.listEndpoints();

  if (endpoints.length === 0) {
    ui.info("No endpoints found. Creating one...");
    const { data: newEp } = await client.createEndpoint("Local Development");
    ui.success(`Created endpoint "${newEp.name}" (${newEp.id})`);
    return newEp;
  }

  if (endpoints.length === 1) {
    const ep = endpoints[0];
    ui.info(`Using endpoint "${ep.name}" (${ep.id})`);
    return ep;
  }

  console.log();
  console.log("  Select an endpoint to tunnel:");
  console.log();
  console.log("     Name                         ID              Webhook URL");
  console.log("  " + "─".repeat(80));

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const name = ep.name.padEnd(28).slice(0, 28);
    const id = (ep.custom_id || ep.id).padEnd(15).slice(0, 15);
    console.log(`  ${i + 1}. ${name} ${id} ${ep.webhook_url}`);
  }
  console.log(`  ${endpoints.length + 1}. [Create new endpoint]`);
  console.log();

  const choice = await prompt(`  > `);
  const index = parseInt(choice, 10);

  if (index === endpoints.length + 1) {
    const name = `Tunnel -> ${targetUrl}`;
    const { data: newEp } = await client.createEndpoint(name);
    ui.success(`Created endpoint "${newEp.name}" (${newEp.id})`);
    return newEp;
  }

  if (index >= 1 && index <= endpoints.length) {
    return endpoints[index - 1];
  }

  ui.error("Invalid selection.");
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
