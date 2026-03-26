import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_HOST, getHost, getProtocol, getWsProtocol, getBaseUrl } from "./constants.js";

describe("constants", () => {
  const originalEnv = process.env.CATCHHOOK_HOST;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CATCHHOOK_HOST;
    } else {
      process.env.CATCHHOOK_HOST = originalEnv;
    }
  });

  describe("DEFAULT_HOST", () => {
    it("is catchhook.app", () => {
      expect(DEFAULT_HOST).toBe("catchhook.app");
    });
  });

  describe("getHost", () => {
    it("returns DEFAULT_HOST when no env var is set", () => {
      delete process.env.CATCHHOOK_HOST;
      expect(getHost()).toBe("catchhook.app");
    });

    it("returns env var when CATCHHOOK_HOST is set", () => {
      process.env.CATCHHOOK_HOST = "catchhook.localhost:3100";
      expect(getHost()).toBe("catchhook.localhost:3100");
    });

    it("returns empty string env var as falsy fallback to default", () => {
      process.env.CATCHHOOK_HOST = "";
      // Empty string is falsy, so || falls through to DEFAULT_HOST
      expect(getHost()).toBe("catchhook.app");
    });
  });

  describe("getProtocol", () => {
    it("returns http for localhost hosts", () => {
      expect(getProtocol("catchhook.localhost:3100")).toBe("http");
      expect(getProtocol("localhost:3000")).toBe("http");
      expect(getProtocol("listen.catchhook.localhost:3100")).toBe("http");
    });

    it("returns https for production hosts", () => {
      expect(getProtocol("catchhook.app")).toBe("https");
      expect(getProtocol("dashboard.catchhook.app")).toBe("https");
      expect(getProtocol("my-app.example.com")).toBe("https");
    });
  });

  describe("getWsProtocol", () => {
    it("returns ws for localhost hosts", () => {
      expect(getWsProtocol("catchhook.localhost:3100")).toBe("ws");
      expect(getWsProtocol("localhost:3000")).toBe("ws");
    });

    it("returns wss for production hosts", () => {
      expect(getWsProtocol("catchhook.app")).toBe("wss");
      expect(getWsProtocol("dashboard.catchhook.app")).toBe("wss");
    });
  });

  describe("getBaseUrl", () => {
    it("builds URL with provided host", () => {
      expect(getBaseUrl("catchhook.app")).toBe("https://catchhook.app");
      expect(getBaseUrl("catchhook.localhost:3100")).toBe("http://catchhook.localhost:3100");
    });

    it("falls back to getHost() when no host provided", () => {
      delete process.env.CATCHHOOK_HOST;
      expect(getBaseUrl()).toBe("https://catchhook.app");
    });

    it("uses env var host when no host provided", () => {
      process.env.CATCHHOOK_HOST = "my.localhost:4000";
      expect(getBaseUrl()).toBe("http://my.localhost:4000");
    });
  });
});
