#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { program } from "commander";
import {
  authLoginCommand,
  authTokenClearCommand,
  authTokenSetCommand,
  authTokenShowCommand,
  authWhoamiCommand,
} from "./commands/auth.js";
import { endpointsCommand } from "./commands/endpoints.js";
import { startCommand } from "./commands/start.js";
import * as ui from "./lib/ui.js";

process.on("unhandledRejection", (err: any) => {
  const msg = err?.message || String(err);
  ui.error(msg);
  process.exit(1);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
const VERSION: string = pkg.version;

function collectValues(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

program
  .name("catchhook-tunnel")
  .description("Tunnel webhooks from CatchHook to your localhost")
  .version(VERSION)
  .enablePositionalOptions();

const auth = program
  .command("auth")
  .description("Authentication and token management commands");

auth
  .command("login")
  .description("Authenticate with your CatchHook account")
  .option("--host <host>", "CatchHook server host (default: catchhook.app)")
  .option("--auth-code <code>", "One-time auth code from /auth/cli")
  .option("--no-browser", "Don't try to open a browser automatically")
  .action(async (options) => {
    ui.banner(VERSION);
    const { browser, ...rest } = options;
    await authLoginCommand({ ...rest, noBrowser: browser === false });
  });

auth
  .command("whoami")
  .description("Verify current authentication and print account identity")
  .option("--host <host>", "CatchHook server host")
  .option("--token <token>", "API token (also saved locally)")
  .action(async (options) => {
    ui.banner(VERSION);
    await authWhoamiCommand(options);
  });

const authToken = auth
  .command("token")
  .description("Manage stored API tokens");

authToken
  .command("set <token>")
  .description("Store an API token locally")
  .option("--host <host>", "Persist host alongside token")
  .action((token, options) => {
    authTokenSetCommand(token, options);
  });

authToken
  .command("show")
  .description("Show masked stored token")
  .action(() => {
    authTokenShowCommand();
  });

authToken
  .command("clear")
  .description("Clear stored token")
  .action(() => {
    authTokenClearCommand();
  });

program
  .command("endpoints")
  .description("List your endpoints")
  .option("--host <host>", "CatchHook server host")
  .option("--token <token>", "API token (also saved locally)")
  .action(async (options) => {
    ui.banner(VERSION);
    await endpointsCommand(options);
  });

program
  .command("start [target]")
  .description("Start tunneling webhooks to localhost")
  .option("-p, --port <port>", "Local port to forward to (default: 3000)")
  .option("-e, --endpoint <id>", "Endpoint ID(s) to tunnel (repeatable)", collectValues, [])
  .option("--all", "Tunnel all endpoints in the account")
  .option("-k, --key <tunnel_key>", "Tunnel key for anonymous mode (skip login)")
  .option("--new", "Create a new endpoint for this tunnel")
  .option("--host <host>", "CatchHook server host")
  .option("--token <token>", "API token (also saved locally)")
  .option("--auth-code <code>", "One-time auth code from /auth/cli")
  .option("--no-browser", "Don't try to open browser for auto-auth")
  .action(async (target, options) => {
    ui.banner(VERSION);
    await startCommand(target, options);
  });

// Default command: if first arg looks like an endpoint ID (starts with "ep_"),
// treat it as anonymous start with positional args.
// Options are defined here for --help output and for the anonymous shorthand:
//   catchhook-tunnel ep_xxx --key tkey_xxx --port 4000
program
  .argument("[endpoint_id]", "Endpoint ID for anonymous tunnel")
  .option("-k, --key <tunnel_key>", "Tunnel key for anonymous mode")
  .option("-p, --port <port>", "Local port to forward to (default: 3000)")
  .option("--host <host>", "CatchHook server host")
  .action(async (endpointId, options) => {
    if (endpointId && options.key) {
      ui.banner(VERSION);
      await startCommand(endpointId, { ...options, key: options.key });
    } else if (endpointId) {
      ui.error(`Missing --key flag. Usage: catchhook-tunnel ${endpointId} --key <tunnel_key> [--port 3000]`);
      process.exit(1);
    } else {
      program.help();
    }
  });

program.parse();
