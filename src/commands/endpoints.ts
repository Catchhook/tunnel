import { getStoredHost, setStoredHost, setStoredToken, resolveToken } from "../lib/config.js";
import { getHost } from "../lib/constants.js";
import { ApiClient } from "../lib/api-client.js";
import * as ui from "../lib/ui.js";

export async function endpointsCommand(options: { host?: string; token?: string }): Promise<void> {
  const { token, source } = resolveToken(options.token);
  if (!token) {
    ui.error("Not authenticated. Set CATCHHOOK_TOKEN, pass --token, or run `catchhook-tunnel start` to auto-authenticate.");
    process.exit(1);
  }

  const host = options.host || getStoredHost() || getHost();
  const client = new ApiClient(token, host);

  try {
    const { data: endpoints } = await client.listEndpoints();

    if (source === "flag") {
      setStoredToken(token);
      setStoredHost(host);
    }

    if (endpoints.length === 0) {
      ui.info("No endpoints found. Create one with `catchhook-tunnel start --new`.");
      return;
    }

    console.log();
    console.log("  Name                         ID              Webhook URL");
    console.log("  " + "─".repeat(80));

    for (const ep of endpoints) {
      const name = ep.name.padEnd(28).slice(0, 28);
      const id = (ep.custom_id || ep.id).padEnd(15).slice(0, 15);
      const tunnelBadge = ep.tunnel_active ? " 🟢" : "";
      console.log(`  ${name} ${id} ${ep.webhook_url}${tunnelBadge}`);
    }

    console.log();
  } catch (err: any) {
    ui.error(err.message || "Failed to list endpoints");
    process.exit(1);
  }
}
