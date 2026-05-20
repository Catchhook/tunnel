import { createInterface } from "node:readline";
import chalk from "chalk";
import type { ForwardResult } from "./forwarder.js";

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

export function banner(version: string): void {
  console.log();
  console.log(chalk.bold.cyan(" catchhook-tunnel") + chalk.gray(`  v${version}`));
  console.log();
}

export interface EndpointInfo {
  name: string;
  id: string;
  webhookUrl: string;
}

type SingleEndpointOpts = {
  endpointName?: string;
  endpointId: string;
  webhookUrl: string;
  endpoints?: never;
};

type MultiEndpointOpts = {
  endpointName?: never;
  endpointId?: never;
  webhookUrl?: never;
  endpoints: EndpointInfo[];
};

type AnonymousOpts = {
  mode: "anonymous";
  email?: never;
  accountName?: never;
  endpointName?: never;
  endpointId: string;
  webhookUrl: string;
  targetUrl: string;
  dashboardUrl?: never;
  expiresIn?: string;
  endpoints?: never;
};

type AuthenticatedOpts = {
  mode: "authenticated";
  email: string;
  accountName: string;
  targetUrl: string;
  dashboardUrl?: string;
  expiresIn?: string;
} & (SingleEndpointOpts | MultiEndpointOpts);

export type ConnectionInfoOpts = AuthenticatedOpts | AnonymousOpts;

export function connectionInfo(opts: ConnectionInfoOpts): void {
  if (opts.mode === "authenticated") {
    console.log(chalk.gray(" Account:    ") + `${opts.email} (${opts.accountName})`);

    if (opts.endpoints && opts.endpoints.length > 0) {
      const label = opts.endpoints.length === 1 ? " Endpoint:   " : " Endpoints:  ";
      console.log(chalk.gray(label) + `${opts.endpoints.length} endpoint${opts.endpoints.length > 1 ? "s" : ""}`);
      for (const ep of opts.endpoints) {
        console.log(chalk.gray("             ") + `${ep.name} (${ep.id})`);
        console.log(chalk.gray("              ") + chalk.underline(ep.webhookUrl));
      }
    } else if (opts.endpointName) {
      console.log(chalk.gray(" Endpoint:   ") + `${opts.endpointName} (${opts.endpointId})`);
      if (opts.webhookUrl) {
        console.log(chalk.gray(" Webhook URL:") + " " + chalk.underline(opts.webhookUrl));
      }
    } else if (opts.endpointId) {
      console.log(chalk.gray(" Endpoint:   ") + opts.endpointId);
      if (opts.webhookUrl) {
        console.log(chalk.gray(" Webhook URL:") + " " + chalk.underline(opts.webhookUrl));
      }
    }
  } else {
    console.log(
      chalk.gray(" Endpoint:   ") +
        `${opts.endpointId} ` +
        chalk.yellow(`(temporary${opts.expiresIn ? `, expires in ${opts.expiresIn}` : ""})`)
    );
    if (opts.webhookUrl) {
      console.log(chalk.gray(" Webhook URL:") + " " + chalk.underline(opts.webhookUrl));
    }
  }

  console.log(chalk.gray(" Forwarding: ") + " " + chalk.green(opts.targetUrl));
  if (opts.dashboardUrl) {
    console.log(chalk.gray(" Dashboard:  ") + " " + chalk.underline(opts.dashboardUrl));
  }

  console.log();
  const urlHint = opts.endpoints && opts.endpoints.length > 1
    ? "Send webhooks to the URLs above."
    : "Send webhooks to the URL above.";
  console.log(chalk.green.bold(" Ready!") + " " + urlHint);
  if (opts.mode === "anonymous") {
    console.log(
      chalk.gray(" Upgrade to Pro for permanent endpoints: ") +
        chalk.underline("https://catchhook.app/signup")
    );
  }
  console.log();
  console.log(chalk.gray(" ─── Requests ") + chalk.gray("─".repeat(50)));
}

export interface RequestLogMeta {
  endpointName?: string;
  contentType?: string | null;
  bodySize?: number;
  ipAddress?: string | null;
  replay?: boolean;
  detectedProvider?: string | null;
  providerEventType?: string | null;
}

function shortContentType(ct: string | null | undefined): string | null {
  if (!ct) return null;
  const lower = ct.toLowerCase();
  if (lower.includes("json")) return "json";
  if (lower.includes("xml")) return "xml";
  if (lower.includes("form-urlencoded")) return "form";
  if (lower.includes("multipart")) return "multipart";
  if (lower.includes("text/plain")) return "text";
  if (lower.includes("text/html")) return "html";
  return ct.split(";")[0].trim();
}

function humanSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes === null) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function requestLog(
  method: string,
  path: string | null,
  result: ForwardResult,
  meta?: RequestLogMeta
): void {
  const time = new Date().toLocaleTimeString();
  const methodStr = chalk.bold(method.padEnd(6));
  const pathStr = path || "/";

  let statusStr: string;
  if (result.error) {
    statusStr = chalk.red(`ERR ${result.error}`);
  } else if (result.statusCode >= 200 && result.statusCode < 300) {
    statusStr = chalk.green(`${result.statusCode} ${result.statusText}`);
  } else if (result.statusCode >= 400 && result.statusCode < 500) {
    statusStr = chalk.yellow(`${result.statusCode} ${result.statusText}`);
  } else {
    statusStr = chalk.red(`${result.statusCode} ${result.statusText}`);
  }

  const timeStr = chalk.gray(`${result.responseTimeMs}ms`);

  const parts: string[] = [` ${chalk.gray(time)}`];

  if (meta?.endpointName) {
    parts.push(` ${chalk.cyan(`[${meta.endpointName}]`)}`);
  }

  if (meta?.detectedProvider) {
    const badge = providerBadge(meta.detectedProvider);
    const eventLabel = meta.providerEventType ? chalk.dim(` ${meta.providerEventType}`) : "";
    parts.push(` ${badge}${eventLabel}`);
  }

  if (meta?.replay) {
    parts.push(`  ${chalk.dim("↺")} ${methodStr}  ${pathStr}`);
  } else {
    parts.push(`  ${methodStr}  ${pathStr}`);
  }

  const details: string[] = [];
  const ct = shortContentType(meta?.contentType);
  if (ct) details.push(ct);
  const size = humanSize(meta?.bodySize);
  if (size) details.push(size);
  if (details.length > 0) {
    parts.push(`  ${chalk.gray(details.join(" "))}`);
  }

  if (meta?.ipAddress) {
    parts.push(`  ${chalk.gray(`from ${meta.ipAddress}`)}`);
  }

  parts.push(`  -> ${statusStr}  ${timeStr}`);

  console.log(parts.join(""));
}

export interface ProviderSetupOpts {
  providerName: string;
  secret: string;
  targetUrl: string;
  webhookUrl?: string;
  endpointId?: string;
  dashboardUrl?: string;
  setupInstructions: string;
  suggestedEvents: string[];
}

export function providerSetupInfo(opts: ProviderSetupOpts): void {
  console.log();
  console.log(chalk.bold.cyan(` ${opts.providerName} Provider Setup`));
  console.log();
  console.log(chalk.gray(" Provider:   ") + chalk.bold(opts.providerName));
  console.log(chalk.gray(" Forwarding: ") + chalk.green(opts.targetUrl));

  if (opts.webhookUrl) {
    console.log(chalk.gray(" Webhook URL:") + " " + chalk.underline(opts.webhookUrl));
  }

  console.log(chalk.gray(" Secret:     ") + chalk.yellow(opts.secret));
  console.log(
    chalk.gray("             ") +
      chalk.dim("(paste this into your webhook settings)")
  );
  console.log();

  if (opts.suggestedEvents.length > 0) {
    console.log(
      chalk.gray(" Suggested events: ") + opts.suggestedEvents.join(", ")
    );
  }
  console.log(chalk.gray(" Setup:      ") + opts.setupInstructions);

  if (opts.dashboardUrl) {
    console.log(chalk.gray(" Dashboard:  ") + chalk.underline(opts.dashboardUrl));
  }

  console.log();
}

export function providerBadge(providerName: string | undefined): string {
  if (!providerName) return "";
  const colors: Record<string, (s: string) => string> = {
    github: chalk.bgWhite.black,
    stripe: chalk.bgMagenta.white,
    shopify: chalk.bgGreen.white,
    twilio: chalk.bgRed.white,
  };
  const colorFn = colors[providerName.toLowerCase()] || chalk.bgGray.white;
  return colorFn(` ${providerName} `);
}

export function info(message: string): void {
  console.log(` ${chalk.gray(timestamp())} ${chalk.blue("ℹ")} ${message}`);
}

export function success(message: string): void {
  console.log(` ${chalk.gray(timestamp())} ${chalk.green("✓")} ${message}`);
}

export function warn(message: string): void {
  console.log(` ${chalk.gray(timestamp())} ${chalk.yellow("⚠")} ${message}`);
}

export function error(message: string): void {
  console.log(` ${chalk.gray(timestamp())} ${chalk.red("✗")} ${message}`);
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(` ${chalk.yellow("?")} ${question} ${chalk.gray("(y/n)")} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}
