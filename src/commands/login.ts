import http from "node:http";
import crypto from "node:crypto";
import open from "open";
import { getBaseUrl, getHost } from "../lib/constants.js";
import { setStoredToken, setStoredHost } from "../lib/config.js";
import { ApiClient } from "../lib/api-client.js";
import * as ui from "../lib/ui.js";

export async function loginCommand(options: { host?: string }): Promise<void> {
  const host = options.host || getHost();
  const baseUrl = getBaseUrl(host);
  const state = crypto.randomBytes(16).toString("hex");

  ui.info(`Authenticating with ${host}...`);

  // Start a temporary localhost server to receive the callback
  const { port, tokenPromise, server } = await startCallbackServer(state);

  const authUrl = `${baseUrl}/auth/cli?callback_port=${port}&state=${state}`;

  try {
    await open(authUrl);
    ui.info("Opening browser for authentication...");
  } catch {
    // Browser failed to open -- fallback to manual flow
    ui.warn("Could not open browser automatically.");
    console.log();
    console.log(`  Open this URL in your browser:`);
    console.log(`  ${authUrl}`);
    console.log();
  }

  ui.info("Waiting for authorization (30s timeout)...");

  try {
    const token = await tokenPromise;

    // Store the token and host
    setStoredToken(token);
    if (host !== "catchhook.app") {
      setStoredHost(host);
    }

    // Verify the token works
    const client = new ApiClient(token, host);
    const verify = await client.verify();

    ui.success(
      `Authenticated as ${verify.data.user.email} (${verify.data.account.name})`
    );
    ui.info("You can now use `catchhook-tunnel start` to begin tunneling.");
  } catch (err: any) {
    ui.error(err.message || "Authentication failed");
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
}

const PAGE_STYLE = `
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#111827}
    .card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:3rem;max-width:420px;width:100%;text-align:center}
    .icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem}
    .icon-ok{background:#ecfdf5;color:#059669}
    .icon-err{background:#fef2f2;color:#dc2626}
    .icon svg{width:28px;height:28px}
    h1{font-size:1.5rem;font-weight:700;margin-bottom:.5rem}
    p{color:#6b7280;line-height:1.6;font-size:.95rem}
    .subtle{margin-top:1.5rem;font-size:.8rem;color:#9ca3af}
  </style>
`;

function successPage(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CatchHook CLI</title>${PAGE_STYLE}</head><body>
  <div class="card">
    <div class="icon icon-ok"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div>
    <h1>CLI Authenticated</h1>
    <p>You can close this tab and return to your terminal.</p>
    <p class="subtle">This page was served by the CatchHook CLI.</p>
  </div>
</body></html>`;
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CatchHook CLI</title>${PAGE_STYLE}</head><body>
  <div class="card">
    <div class="icon icon-err"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body></html>`;
}

function startCallbackServer(
  expectedState: string
): Promise<{ port: number; tokenPromise: Promise<string>; server: http.Server }> {
  return new Promise((resolve) => {
    let resolveToken: (token: string) => void;
    let rejectToken: (err: Error) => void;

    const tokenPromise = new Promise<string>((res, rej) => {
      resolveToken = res;
      rejectToken = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        const state = url.searchParams.get("state");

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("Authentication Failed", "Invalid state parameter. Please try again."));
          rejectToken(new Error("State mismatch — possible CSRF attack"));
          return;
        }

        if (!token) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("Authentication Failed", "No token was received. Please try again."));
          rejectToken(new Error("No token in callback"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage(), () => {
          // Resolve only after the response is fully flushed to the browser
          resolveToken(token);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Listen on random port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      // 30s timeout
      setTimeout(() => {
        rejectToken(new Error("Authentication timed out. Please try again."));
        server.close();
      }, 30_000);

      resolve({ port, tokenPromise, server });
    });
  });
}
