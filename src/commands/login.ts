import http from "node:http";
import crypto from "node:crypto";
import open from "open";
import { getBaseUrl, getHost } from "../lib/constants.js";
import { setStoredToken, setStoredHost } from "../lib/config.js";
import { exchangeCliAuthCode, type AuthIdentity } from "../lib/api-client.js";
import * as ui from "../lib/ui.js";

export interface LoginOptions {
  host?: string;
  authCode?: string;
  noBrowser?: boolean;
  timeoutMs?: number;
}

export interface LoginResult {
  token: string;
  host: string;
  identity: AuthIdentity;
}

export async function loginCommand(options: LoginOptions): Promise<LoginResult> {
  const host = options.host || getHost();

  if (options.authCode) {
    ui.info(`Completing authentication with one-time code on ${host}...`);
    return completeCodeExchange(options.authCode, host);
  }

  const baseUrl = getBaseUrl(host);
  const state = crypto.randomBytes(16).toString("hex");
  const timeoutMs = options.timeoutMs ?? 60_000;

  ui.info(`Authenticating with ${host}...`);

  // Start a temporary localhost server to receive the callback code
  const { port, authCodePromise, server } = await startCallbackServer(state, timeoutMs);
  const authUrl = `${baseUrl}/auth/cli?callback_port=${port}&state=${state}`;

  try {
    if (options.noBrowser) {
      console.log();
      console.log("  Open this URL in your browser to authorize:");
      console.log(`  ${authUrl}`);
      console.log();
    } else {
      try {
        await open(authUrl);
        ui.info("Opening browser for authentication...");
      } catch {
        ui.warn("Could not open browser automatically.");
        console.log();
        console.log("  Open this URL in your browser:");
        console.log(`  ${authUrl}`);
        console.log();
      }
    }

    ui.info(`Waiting for authorization (${Math.floor(timeoutMs / 1000)}s timeout)...`);
    const authCode = await authCodePromise;
    return await completeCodeExchange(authCode, host);
  } finally {
    server.close();
  }
}

async function completeCodeExchange(authCode: string, host: string): Promise<LoginResult> {
  const exchange = await exchangeCliAuthCode(authCode, host);
  const token = exchange.data.token;
  const identity: AuthIdentity = {
    user: exchange.data.user,
    account: exchange.data.account,
  };

  setStoredToken(token);
  setStoredHost(host);

  ui.success(`Authenticated as ${identity.user.email} (${identity.account.name})`);

  return { token, host, identity };
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
  expectedState: string,
  timeoutMs: number
): Promise<{ port: number; authCodePromise: Promise<string>; server: http.Server }> {
  return new Promise((resolve) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    let settled = false;

    const authCodePromise = new Promise<string>((res, rej) => {
      resolveCode = (code: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        res(code);
      };
      rejectCode = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rej(err);
      };
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");

      if (url.pathname === "/callback") {
        const authCode = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("Authentication Failed", "Invalid state parameter. Please try again."));
          rejectCode(new Error("State mismatch - possible CSRF attack"));
          return;
        }

        if (!authCode) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("Authentication Failed", "No auth code was received. Please try again."));
          rejectCode(new Error("No auth code in callback"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage(), () => {
          resolveCode(authCode);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const timeout = setTimeout(() => {
      rejectCode(new Error("Authentication timed out. Please try again."));
      server.close();
    }, timeoutMs);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, authCodePromise, server });
    });
  });
}
