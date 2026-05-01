import {
  clearStoredHost,
  clearStoredToken,
  getConfigPath,
  getStoredHost,
  getStoredToken,
  resolveToken,
  setStoredHost,
  setStoredToken,
} from "../lib/config.js";
import { getHost } from "../lib/constants.js";
import { ApiClient } from "../lib/api-client.js";
import { loginCommand } from "./login.js";
import * as ui from "../lib/ui.js";

export async function authLoginCommand(options: {
  host?: string;
  authCode?: string;
  noBrowser?: boolean;
}): Promise<void> {
  const host = options.host || getStoredHost() || getHost();
  await loginCommand({
    host,
    authCode: options.authCode,
    noBrowser: options.noBrowser,
  });
  ui.info("Run `catchhook-tunnel start --endpoint <id>` to begin tunneling.");
}

export function authTokenSetCommand(token: string, options: { host?: string }): void {
  setStoredToken(token);
  if (options.host) {
    setStoredHost(options.host);
  }
  ui.success(`Token saved to ${getConfigPath()}`);
}

export function authTokenClearCommand(): void {
  clearStoredToken();
  clearStoredHost();
  ui.success("Stored token and host cleared.");
}

export function authTokenShowCommand(): void {
  const token = getStoredToken();
  if (!token) {
    ui.info("No stored token.");
    return;
  }
  const masked = `${token.slice(0, 12)}...`;
  ui.info(`Stored token: ${masked}`);
}

export async function authWhoamiCommand(options: { host?: string; token?: string }): Promise<void> {
  const host = options.host || getStoredHost() || getHost();
  const { token, source } = resolveToken(options.token);
  if (!token) {
    ui.error("No token available. Pass --token, set CATCHHOOK_TOKEN, or run `catchhook-tunnel start`.");
    process.exit(1);
  }

  const client = new ApiClient(token, host);
  try {
    const verify = await client.verify();
    if (source === "flag") {
      setStoredToken(token);
      setStoredHost(host);
    }
    ui.success(`Authenticated as ${verify.data.user.email} (${verify.data.account.name})`);
  } catch (err: any) {
    ui.error(err.message || "Token verification failed.");
    process.exit(1);
  }
}
