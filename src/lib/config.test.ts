import { describe, it, expect, beforeEach } from "vitest";
import {
  getStoredToken,
  setStoredToken,
  getStoredHost,
  setStoredHost,
  clearConfig,
  getConfigPath,
} from "./config.js";

describe("config", () => {
  beforeEach(() => {
    // Start each test with a clean config
    clearConfig();
  });

  describe("token storage", () => {
    it("returns undefined when no token is stored", () => {
      expect(getStoredToken()).toBeUndefined();
    });

    it("stores and retrieves a token", () => {
      setStoredToken("chk_test_token_123");
      expect(getStoredToken()).toBe("chk_test_token_123");
    });

    it("overwrites existing token", () => {
      setStoredToken("chk_first");
      setStoredToken("chk_second");
      expect(getStoredToken()).toBe("chk_second");
    });
  });

  describe("host storage", () => {
    it("returns undefined when no host is stored", () => {
      expect(getStoredHost()).toBeUndefined();
    });

    it("stores and retrieves a host", () => {
      setStoredHost("catchhook.localhost:3100");
      expect(getStoredHost()).toBe("catchhook.localhost:3100");
    });
  });

  describe("clearConfig", () => {
    it("clears all stored values", () => {
      setStoredToken("chk_test");
      setStoredHost("localhost:3100");
      clearConfig();
      expect(getStoredToken()).toBeUndefined();
      expect(getStoredHost()).toBeUndefined();
    });
  });

  describe("getConfigPath", () => {
    it("returns a non-empty file path", () => {
      const path = getConfigPath();
      expect(path).toBeTruthy();
      expect(typeof path).toBe("string");
      expect(path.length).toBeGreaterThan(0);
    });
  });
});
