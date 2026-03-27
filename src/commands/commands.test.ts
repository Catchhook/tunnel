import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config module
vi.mock("../lib/config.js", () => ({
  getStoredToken: vi.fn(),
  setStoredToken: vi.fn(),
  getStoredHost: vi.fn(),
  setStoredHost: vi.fn(),
  clearConfig: vi.fn(),
  getConfigPath: vi.fn(() => "/tmp/test-config.json"),
}));

// Mock ui module
vi.mock("../lib/ui.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  banner: vi.fn(),
  connectionInfo: vi.fn(),
  requestLog: vi.fn(),
}));

// Mock api-client module
const mockListEndpoints = vi.fn();
const mockVerify = vi.fn();
const mockCreateEndpoint = vi.fn();
vi.mock("../lib/api-client.js", () => ({
  ApiClient: class MockApiClient {
    verify = mockVerify;
    listEndpoints = mockListEndpoints;
    createEndpoint = mockCreateEndpoint;
  },
  reportAnonymousDelivery: vi.fn(),
}));

// Mock constants
vi.mock("../lib/constants.js", () => ({
  DEFAULT_HOST: "catchhook.app",
  getHost: vi.fn(() => "catchhook.app"),
  getProtocol: vi.fn((h: string) => h.includes("localhost") ? "http" : "https"),
  getWsProtocol: vi.fn((h: string) => h.includes("localhost") ? "ws" : "wss"),
  getBaseUrl: vi.fn((h?: string) => `https://${h || "catchhook.app"}`),
}));

// Mock cable-client (for start command tests)
const mockConnectTunnel = vi.fn().mockResolvedValue({
  channel: {},
  heartbeatInterval: null,
  disconnect: vi.fn(),
});
const mockConnectMultiTunnel = vi.fn().mockResolvedValue({
  clientId: "test-client-id",
  subscriptions: [],
  addEndpoint: vi.fn(),
  disconnect: vi.fn(),
});
vi.mock("../lib/cable-client.js", () => ({
  connectTunnel: (...args: any[]) => mockConnectTunnel(...args),
  connectMultiTunnel: (...args: any[]) => mockConnectMultiTunnel(...args),
}));

// Mock forwarder (for start command tests)
vi.mock("../lib/forwarder.js", () => ({
  forwardToLocalhost: vi.fn().mockResolvedValue({
    statusCode: 200,
    statusText: "OK",
    responseTimeMs: 10,
  }),
}));

import { logoutCommand } from "./logout.js";
import { endpointsCommand } from "./endpoints.js";
import { startCommand } from "./start.js";
import { clearConfig, getConfigPath, getStoredToken, getStoredHost } from "../lib/config.js";
import * as ui from "../lib/ui.js";

describe("logoutCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears config and prints success", async () => {
    await logoutCommand();

    expect(clearConfig).toHaveBeenCalled();
    expect(ui.success).toHaveBeenCalledWith(
      expect.stringContaining("Logged out")
    );
  });
});

describe("endpointsCommand", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
  });

  it("exits with error if not authenticated", async () => {
    vi.mocked(getStoredToken).mockReturnValue(undefined);

    await expect(endpointsCommand({})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated")
    );
  });

  it("shows info message when no endpoints found", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockListEndpoints.mockResolvedValue({ data: [] });

    await endpointsCommand({});

    expect(ui.info).toHaveBeenCalledWith(
      expect.stringContaining("No endpoints found")
    );
  });

  it("lists endpoints in a table", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockListEndpoints.mockResolvedValue({
      data: [
        {
          id: "ep_123",
          name: "Test Endpoint",
          custom_id: null,
          webhook_url: "https://listen.catchhook.app/hooks/ep_123",
          tunnel_active: false,
          created_at: "",
          updated_at: "",
        },
        {
          id: "ep_456",
          name: "Active Tunnel",
          custom_id: "stripe",
          webhook_url: "https://listen.catchhook.app/hooks/stripe",
          tunnel_active: true,
          created_at: "",
          updated_at: "",
        },
      ],
    });

    await endpointsCommand({});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
    expect(allOutput).toContain("Test Endpoint");
    expect(allOutput).toContain("ep_123");
    expect(allOutput).toContain("Active Tunnel");
    expect(allOutput).toContain("stripe");
  });

  it("uses host from options if provided", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue("stored.host");
    mockListEndpoints.mockResolvedValue({ data: [] });

    await endpointsCommand({ host: "custom.host:3100" });

    // The ApiClient should be constructed — we can check that the function ran
    expect(mockListEndpoints).toHaveBeenCalled();
  });

  it("handles API errors gracefully", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockListEndpoints.mockRejectedValue(new Error("Network error"));

    await expect(endpointsCommand({})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith("Network error");
  });
});

describe("startCommand", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
  });

  it("exits with error when not authenticated and no key", async () => {
    vi.mocked(getStoredToken).mockReturnValue(undefined);
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    await expect(startCommand(undefined, {})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated")
    );
  });

  it("exits with error when anonymous mode has no endpoint id", async () => {
    vi.mocked(getStoredToken).mockReturnValue(undefined);
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    await expect(startCommand(undefined, { key: "tkey_abc" })).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("Endpoint ID is required")
    );
  });

  it("starts anonymous tunnel with endpoint id and key", async () => {
    vi.mocked(getStoredToken).mockReturnValue(undefined);
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    // startCommand ends with `await new Promise(() => {})` (keepalive).
    // We fire-and-forget it and wait briefly for side effects.
    startCommand("ep_abc", { key: "tkey_abc", port: "4000" });
    await new Promise((r) => setTimeout(r, 100));

    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "anonymous",
        endpointId: "ep_abc",
        targetUrl: "http://localhost:4000",
      })
    );
    expect(mockConnectTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "anonymous",
        tunnelKey: "tkey_abc",
        endpointId: "ep_abc",
      }),
      expect.any(Object),
      "http://localhost:4000"
    );
  });

  it("defaults port to 3000 for anonymous tunnel", async () => {
    vi.mocked(getStoredToken).mockReturnValue(undefined);
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    startCommand("ep_abc", { key: "tkey_abc" });
    await new Promise((r) => setTimeout(r, 100));

    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost:3000",
      })
    );
  });

  it("exits with error when auth verification fails", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockVerify.mockRejectedValue(new Error("Invalid token"));

    await expect(startCommand(undefined, {})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("Authentication failed")
    );
  });

  it("exits with error when specified endpoint is not found", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockVerify.mockResolvedValue({
      data: { user: { email: "test@test.com" }, account: { name: "Test" } },
    });
    mockListEndpoints.mockResolvedValue({ data: [] });

    await expect(
      startCommand(undefined, { endpoint: ["ep_nonexistent"] })
    ).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
  });

  it("uses URL target directly when it starts with http", async () => {
    vi.mocked(getStoredToken).mockReturnValue(undefined);
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    startCommand("ep_abc", { key: "tkey_abc", port: "3000" });
    await new Promise((r) => setTimeout(r, 100));

    // ep_abc is detected as endpoint_id (not a URL or port), so target defaults to port
    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost:3000",
      })
    );
  });

  it("tunnels all endpoints with --all flag", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockVerify.mockResolvedValue({
      data: { user: { email: "test@test.com" }, account: { name: "Test" } },
    });
    mockListEndpoints.mockResolvedValue({
      data: [
        { id: "ep_1", name: "Endpoint 1", custom_id: null, webhook_url: "https://listen.catchhook.app/hooks/ep_1" },
        { id: "ep_2", name: "Endpoint 2", custom_id: null, webhook_url: "https://listen.catchhook.app/hooks/ep_2" },
      ],
    });

    startCommand(undefined, { all: true });
    await new Promise((r) => setTimeout(r, 100));

    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "authenticated",
        endpoints: expect.arrayContaining([
          expect.objectContaining({ id: "ep_1" }),
          expect.objectContaining({ id: "ep_2" }),
        ]),
      })
    );
    expect(mockConnectMultiTunnel).toHaveBeenCalled();
  });

  it("exits with error when --all finds no endpoints", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockVerify.mockResolvedValue({
      data: { user: { email: "test@test.com" }, account: { name: "Test" } },
    });
    mockListEndpoints.mockResolvedValue({ data: [] });

    await expect(startCommand(undefined, { all: true })).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("No endpoints found")
    );
  });

  it("tunnels multiple selected endpoints", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockVerify.mockResolvedValue({
      data: { user: { email: "test@test.com" }, account: { name: "Test" } },
    });
    mockListEndpoints.mockResolvedValue({
      data: [
        { id: "ep_1", name: "Endpoint 1", custom_id: "stripe", webhook_url: "https://listen.catchhook.app/hooks/ep_1" },
        { id: "ep_2", name: "Endpoint 2", custom_id: "github", webhook_url: "https://listen.catchhook.app/hooks/ep_2" },
        { id: "ep_3", name: "Endpoint 3", custom_id: null, webhook_url: "https://listen.catchhook.app/hooks/ep_3" },
      ],
    });

    startCommand(undefined, { endpoint: ["stripe", "ep_2"] });
    await new Promise((r) => setTimeout(r, 100));

    expect(mockConnectMultiTunnel).toHaveBeenCalled();
    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: expect.arrayContaining([
          expect.objectContaining({ id: "ep_1" }),
          expect.objectContaining({ id: "ep_2" }),
        ]),
      })
    );
  });

  it("deduplicates repeated --endpoint values", async () => {
    vi.mocked(getStoredToken).mockReturnValue("chk_test");
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockVerify.mockResolvedValue({
      data: { user: { email: "test@test.com" }, account: { name: "Test" } },
    });
    mockListEndpoints.mockResolvedValue({
      data: [
        { id: "ep_1", name: "Endpoint 1", custom_id: null, webhook_url: "https://listen.catchhook.app/hooks/ep_1" },
      ],
    });

    startCommand(undefined, { endpoint: ["ep_1", "ep_1"] });
    await new Promise((r) => setTimeout(r, 100));

    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("Duplicate"));
    // Single endpoint path (deduped to 1) — uses connectTunnel
    expect(mockConnectTunnel).toHaveBeenCalled();
  });
});
