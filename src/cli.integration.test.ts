import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "index.ts");

function runCli(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI_ENTRY, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd: resolve(__dirname, ".."),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("CLI integration", () => {
  describe("--help", () => {
    it("shows usage information", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("catchhook-tunnel");
      expect(stdout).toContain("Tunnel webhooks");
    });

    it("lists all commands", () => {
      const { stdout } = runCli(["--help"]);
      expect(stdout).toContain("auth");
      expect(stdout).toContain("endpoints");
      expect(stdout).toContain("start");
    });
  });

  describe("--version", () => {
    it("prints the version", () => {
      const { stdout, exitCode } = runCli(["--version"]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("auth login --help", () => {
    it("shows auth login command options", () => {
      const { stdout, exitCode } = runCli(["auth", "login", "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Authenticate");
      expect(stdout).toContain("--host");
    });
  });

  describe("auth token --help", () => {
    it("shows token subcommands", () => {
      const { stdout, exitCode } = runCli(["auth", "token", "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("set");
      expect(stdout).toContain("show");
      expect(stdout).toContain("clear");
    });
  });

  describe("start --help", () => {
    it("shows start command options", () => {
      const { stdout, exitCode } = runCli(["start", "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--port");
      expect(stdout).toContain("--endpoint");
      expect(stdout).toContain("--key");
      expect(stdout).toContain("--new");
      expect(stdout).toContain("--token");
    });
  });

  describe("anonymous shorthand (ep_xxx --key)", () => {
    it("parses --key and --port after the endpoint ID", () => {
      const { stdout } = runCli([
        "ep_test123", "--key", "tkey_fake", "--port", "9999",
      ]);
      // The banner only appears when options are parsed and startCommand runs.
      // If options were swallowed, we'd see "Missing --key flag" instead.
      expect(stdout).not.toContain("Missing --key");
      expect(stdout).toContain("9999");
    }, 15_000);

    it("shows error when endpoint ID is given without --key", () => {
      const { stdout, exitCode } = runCli(["ep_test123"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("--key");
    });

    it("shows help when invoked with no arguments", () => {
      const { stdout, exitCode } = runCli([]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("catchhook-tunnel");
      expect(stdout).toContain("start");
      expect(stdout).toContain("auth");
    });
  });
});
