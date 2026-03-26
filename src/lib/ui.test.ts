import { describe, it, expect, vi, beforeEach } from "vitest";
import { banner, connectionInfo, requestLog, info, success, warn, error } from "./ui.js";
import type { ForwardResult } from "./forwarder.js";

describe("ui", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("banner", () => {
    it("prints version info", () => {
      banner("0.1.0");
      const output = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
      expect(output).toContain("catchhook-tunnel");
      expect(output).toContain("0.1.0");
    });
  });

  describe("connectionInfo", () => {
    it("prints authenticated mode info", () => {
      connectionInfo({
        mode: "authenticated",
        email: "user@example.com",
        accountName: "Test Account",
        endpointName: "My Endpoint",
        endpointId: "ep_123",
        webhookUrl: "https://listen.catchhook.app/hooks/ep_123",
        targetUrl: "http://localhost:3000",
        dashboardUrl: "https://catchhook.app/endpoints/ep_123",
      });

      const output = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
      expect(output).toContain("user@example.com");
      expect(output).toContain("Test Account");
      expect(output).toContain("My Endpoint");
      expect(output).toContain("ep_123");
      expect(output).toContain("localhost:3000");
      expect(output).toContain("Ready!");
    });

    it("prints anonymous mode info with upgrade prompt", () => {
      connectionInfo({
        mode: "anonymous",
        endpointId: "ep_tmp",
        webhookUrl: "https://temp.catchhook.app/hooks/ep_tmp",
        targetUrl: "http://localhost:3000",
        expiresIn: "47 hours",
      });

      const output = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
      expect(output).toContain("temporary");
      expect(output).toContain("47 hours");
      expect(output).toContain("Upgrade to Pro");
    });
  });

  describe("requestLog", () => {
    it("logs successful requests", () => {
      const result: ForwardResult = { statusCode: 200, statusText: "OK", responseTimeMs: 42 };
      requestLog("POST", "/webhook", result);

      const output = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
      expect(output).toContain("POST");
      expect(output).toContain("/webhook");
      expect(output).toContain("200");
      expect(output).toContain("42ms");
    });

    it("logs error requests", () => {
      const result: ForwardResult = { statusCode: 0, statusText: "Error", responseTimeMs: 5, error: "Connection refused" };
      requestLog("POST", "/hook", result);

      const output = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
      expect(output).toContain("ERR");
      expect(output).toContain("Connection refused");
    });

    it("handles null path", () => {
      const result: ForwardResult = { statusCode: 200, statusText: "OK", responseTimeMs: 10 };
      requestLog("GET", null, result);

      const output = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
      expect(output).toContain("/");
    });
  });

  describe("message helpers", () => {
    it("info prints a message", () => {
      info("test info");
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain("test info");
    });

    it("success prints a message", () => {
      success("test success");
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain("test success");
    });

    it("warn prints a message", () => {
      warn("test warning");
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain("test warning");
    });

    it("error prints a message", () => {
      error("test error");
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain("test error");
    });
  });
});
