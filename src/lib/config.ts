import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Conf from "conf";
import type { AuthIdentity } from "./api-client.js";
import { ApiClient } from "./api-client.js";
import * as ui from "./ui.js";

interface CatchHookConfig {
  token?: string;
  host?: string;
  installationId?: string;
  clientName?: string;
  replayCommandJournal?: Record<string, number>;
}

const CONF_SCHEMA = {
  token: { type: "string" as const },
  host: { type: "string" as const },
  installationId: { type: "string" as const },
  clientName: { type: "string" as const },
  replayCommandJournal: {
    type: "object" as const,
    additionalProperties: { type: "number" as const },
  },
};

function createConf(): Conf<CatchHookConfig> {
  if (process.env.CATCHHOOK_CONFIG_DIR) {
    const configDir = process.env.CATCHHOOK_CONFIG_DIR;
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.accessSync(configDir, fs.constants.W_OK);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CATCHHOOK_CONFIG_DIR '${configDir}' is not writable or cannot be created: ${msg}`);
    }
    return new Conf<CatchHookConfig>({ projectName: "catchhook", cwd: configDir, schema: CONF_SCHEMA });
  }

  // Try the default OS config path (env-paths handles macOS/Linux/Windows).
  // Fall back to a per-user $TMPDIR directory for restricted sandboxes.
  try {
    const c = new Conf<CatchHookConfig>({ projectName: "catchhook", schema: CONF_SCHEMA });
    c.get("token");
    return c;
  } catch {
    const uid = typeof process.getuid === "function"
      ? String(process.getuid())
      : (process.env.USER || process.env.USERNAME || String(process.pid));
    const fallbackDir = path.join(os.tmpdir(), `catchhook-config-${uid}`);

    try {
      const stats = fs.lstatSync(fallbackDir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `Unsafe config path '${fallbackDir}' (symlink or not a directory). ` +
          `Set CATCHHOOK_CONFIG_DIR to a secure directory you control.`
        );
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
      } else {
        throw err;
      }
    }

    try { fs.chmodSync(fallbackDir, 0o700); } catch {}
    return new Conf<CatchHookConfig>({ projectName: "catchhook", cwd: fallbackDir, schema: CONF_SCHEMA });
  }
}

const config = createConf();

export function getStoredToken(): string | undefined {
  return config.get("token");
}

export function setStoredToken(token: string): void {
  config.set("token", token);
}

export function clearStoredToken(): void {
  config.delete("token");
}

export function getStoredHost(): string | undefined {
  return config.get("host");
}

export function setStoredHost(host: string): void {
  config.set("host", host);
}

export function clearStoredHost(): void {
  config.delete("host");
}

export function clearConfig(): void {
  config.clear();
}

export function getConfigPath(): string {
  return config.path;
}

export function getInstallationIdentity(nameOverride?: string): { installationId: string; clientName: string } {
  let installationId = config.get("installationId");
  if (!installationId) {
    installationId = randomUUID();
    config.set("installationId", installationId);
  }

  if (nameOverride) config.set("clientName", nameOverride.slice(0, 80));
  let clientName = config.get("clientName");
  if (!clientName) {
    clientName = os.hostname().slice(0, 80) || "Local client";
    config.set("clientName", clientName);
  }
  return { installationId, clientName };
}

export function claimReplayCommand(commandId: string, expiresAt: string): boolean {
  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= now) return false;

  const journal = config.get("replayCommandJournal") || {};
  for (const [id, expiry] of Object.entries(journal)) {
    if (expiry <= now) delete journal[id];
  }
  if (journal[commandId]) return false;
  journal[commandId] = expiry;
  config.set("replayCommandJournal", journal);
  return true;
}

export type TokenSource = "flag" | "env" | "stored" | "none";

export function resolveToken(tokenFromFlag?: string): { token?: string; source: TokenSource } {
  if (tokenFromFlag) return { token: tokenFromFlag, source: "flag" };
  if (process.env.CATCHHOOK_TOKEN) return { token: process.env.CATCHHOOK_TOKEN, source: "env" };

  const stored = getStoredToken();
  if (stored) return { token: stored, source: "stored" };

  return { token: undefined, source: "none" };
}

export interface EnsureAuthOptions {
  token?: string;
  authCode?: string;
  browser?: boolean;
  host?: string;
}

type LoginFn = (opts: { host: string; authCode?: string; noBrowser?: boolean }) =>
  Promise<{ token: string; host: string; identity: AuthIdentity }>;

export async function ensureAuthenticatedToken(
  host: string,
  options: EnsureAuthOptions,
  login: LoginFn
): Promise<{ token: string; identity: AuthIdentity }> {
  const { token: configuredToken, source } = resolveToken(options.token);
  let token = configuredToken;
  let identity: AuthIdentity | null = null;

  if (token) {
    const client = new ApiClient(token, host);
    try {
      const verify = await client.verify();
      identity = verify.data;
      if (source === "flag") {
        setStoredToken(token);
        setStoredHost(host);
      }
    } catch {
      if (source === "flag" || source === "env") {
        ui.error("Provided API token is invalid or expired.");
        process.exit(1);
      }
      if (source === "stored") {
        clearStoredToken();
      }
      token = undefined;
    }
  }

  if (!token || !identity) {
    ui.info("No valid stored authentication found. Starting browser authentication...");
    const login_ = await login({
      host,
      authCode: options.authCode,
      noBrowser: options.browser === false,
    });
    token = login_.token;
    identity = login_.identity;
    ui.info("You can now re-run this command with --token or CATCHHOOK_TOKEN for headless usage.");
  }

  return { token, identity };
}
