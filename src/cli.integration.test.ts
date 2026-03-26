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
      expect(stdout).toContain("login");
      expect(stdout).toContain("logout");
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

  describe("login --help", () => {
    it("shows login command options", () => {
      const { stdout, exitCode } = runCli(["login", "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Authenticate");
      expect(stdout).toContain("--host");
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
    });
  });

  describe("logout", () => {
    it("runs without error", () => {
      const { stdout, exitCode } = runCli(["logout"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Logged out");
    });
  });

  describe("endpoints (unauthenticated)", () => {
    it("shows auth error when not logged in", () => {
      // Clear any stored config first
      runCli(["logout"]);
      const { stdout, exitCode } = runCli(["endpoints"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("Not authenticated");
    }, 15_000); // Two sequential process spawns need extra time
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
    });

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
    });
  });
});
