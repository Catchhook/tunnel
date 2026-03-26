#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { program } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { endpointsCommand } from "./commands/endpoints.js";
import { startCommand } from "./commands/start.js";
import * as ui from "./lib/ui.js";

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

program
  .command("login")
  .description("Authenticate with your CatchHook account via browser")
  .option("--host <host>", "CatchHook server host (default: catchhook.app)")
  .action(async (options) => {
    ui.banner(VERSION);
    await loginCommand(options);
  });

program
  .command("logout")
  .description("Clear stored authentication credentials")
  .action(async () => {
    await logoutCommand();
  });

program
  .command("endpoints")
  .description("List your endpoints")
  .option("--host <host>", "CatchHook server host")
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
