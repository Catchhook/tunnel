import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  getStoredHost,
  setStoredHost,
  clearStoredHost,
  clearConfig,
  getConfigPath,
  resolveToken,
  ensureAuthenticatedToken,
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

  describe("clearStoredToken", () => {
    it("removes only the token", () => {
      setStoredToken("chk_clear_me");
      setStoredHost("myhost");
      clearStoredToken();
      expect(getStoredToken()).toBeUndefined();
      expect(getStoredHost()).toBe("myhost");
    });
  });

  describe("clearStoredHost", () => {
    it("removes only the host", () => {
      setStoredToken("chk_keep");
      setStoredHost("removeme");
      clearStoredHost();
      expect(getStoredHost()).toBeUndefined();
      expect(getStoredToken()).toBe("chk_keep");
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

  describe("resolveToken", () => {
    const savedEnv = process.env.CATCHHOOK_TOKEN;

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.CATCHHOOK_TOKEN;
      } else {
        process.env.CATCHHOOK_TOKEN = savedEnv;
      }
    });

    it("returns flag token with source flag", () => {
      const result = resolveToken("chk_from_flag");
      expect(result).toEqual({ token: "chk_from_flag", source: "flag" });
    });

    it("returns env token when no flag is given", () => {
      process.env.CATCHHOOK_TOKEN = "chk_from_env";
      const result = resolveToken();
      expect(result).toEqual({ token: "chk_from_env", source: "env" });
    });

    it("returns stored token when no flag or env", () => {
      delete process.env.CATCHHOOK_TOKEN;
      setStoredToken("chk_stored");
      const result = resolveToken();
      expect(result).toEqual({ token: "chk_stored", source: "stored" });
    });

    it("returns none when nothing is available", () => {
      delete process.env.CATCHHOOK_TOKEN;
      const result = resolveToken();
      expect(result).toEqual({ token: undefined, source: "none" });
    });

    it("flag takes priority over env and stored", () => {
      process.env.CATCHHOOK_TOKEN = "chk_env";
      setStoredToken("chk_stored");
      const result = resolveToken("chk_flag");
      expect(result.source).toBe("flag");
      expect(result.token).toBe("chk_flag");
    });
  });

  describe("ensureAuthenticatedToken", () => {
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as any);
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    it("returns token and identity when stored token verifies", async () => {
      setStoredToken("chk_valid");
      const mockLogin = vi.fn();
      const identity = {
        user: { id: "usr_1", email: "dev@test.com", name: "Dev" },
        account: { id: "acct_1", name: "Test", plan: "pro" },
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: identity }),
      }) as any;

      try {
        const result = await ensureAuthenticatedToken("catchhook.app", {}, mockLogin);
        expect(result.token).toBe("chk_valid");
        expect(result.identity).toEqual(identity);
        expect(mockLogin).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("falls back to login when no token is available", async () => {
      clearConfig();
      delete process.env.CATCHHOOK_TOKEN;

      const identity = {
        user: { id: "usr_1", email: "dev@test.com", name: "Dev" },
        account: { id: "acct_1", name: "Test", plan: "pro" },
      };
      const mockLogin = vi.fn().mockResolvedValue({
        token: "chk_fresh",
        host: "catchhook.app",
        identity,
      });

      const result = await ensureAuthenticatedToken("catchhook.app", {}, mockLogin);
      expect(result.token).toBe("chk_fresh");
      expect(result.identity).toEqual(identity);
      expect(mockLogin).toHaveBeenCalled();
    });

    it("exits when flag token verification fails", async () => {
      const mockLogin = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
        statusText: "Unauthorized",
      }) as any;

      try {
        await expect(
          ensureAuthenticatedToken("catchhook.app", { token: "chk_bad" }, mockLogin)
        ).rejects.toThrow("process.exit");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("clears stored token and falls back to login on stored token failure", async () => {
      setStoredToken("chk_expired");
      const identity = {
        user: { id: "usr_1", email: "dev@test.com", name: "Dev" },
        account: { id: "acct_1", name: "Test", plan: "pro" },
      };
      const mockLogin = vi.fn().mockResolvedValue({
        token: "chk_new",
        host: "catchhook.app",
        identity,
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
        statusText: "Unauthorized",
      }) as any;

      try {
        const result = await ensureAuthenticatedToken("catchhook.app", {}, mockLogin);
        expect(result.token).toBe("chk_new");
        expect(getStoredToken()).toBeUndefined();
        expect(mockLogin).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
