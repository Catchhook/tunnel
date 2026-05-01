import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEnsureAuthenticatedToken = vi.fn();
vi.mock("../lib/config.js", () => ({
  getStoredToken: vi.fn(),
  setStoredToken: vi.fn(),
  getStoredHost: vi.fn(),
  setStoredHost: vi.fn(),
  clearStoredToken: vi.fn(),
  clearStoredHost: vi.fn(),
  clearConfig: vi.fn(),
  getConfigPath: vi.fn(() => "/tmp/test-config.json"),
  resolveToken: vi.fn(),
  ensureAuthenticatedToken: (...args: any[]) => mockEnsureAuthenticatedToken(...args),
}));

vi.mock("../lib/ui.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  banner: vi.fn(),
  connectionInfo: vi.fn(),
  requestLog: vi.fn(),
}));

const mockListEndpoints = vi.fn();
const mockVerify = vi.fn();
const mockCreateEndpoint = vi.fn();
vi.mock("../lib/api-client.js", () => ({
  ApiClient: class MockApiClient {
    verify = mockVerify;
    listEndpoints = mockListEndpoints;
    createEndpoint = mockCreateEndpoint;
    reportDelivery = vi.fn();
    getMissedRequests = vi.fn().mockResolvedValue([]);
    getUndeliveredRequests = vi.fn().mockResolvedValue([]);
  },
  reportAnonymousDelivery: vi.fn(),
  getAnonymousMissedRequests: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/constants.js", () => ({
  DEFAULT_HOST: "catchhook.app",
  getHost: vi.fn(() => "catchhook.app"),
  getProtocol: vi.fn((h: string) => h.includes("localhost") ? "http" : "https"),
  getWsProtocol: vi.fn((h: string) => h.includes("localhost") ? "ws" : "wss"),
  getBaseUrl: vi.fn((h?: string) => `https://${h || "catchhook.app"}`),
}));

const mockRunSingleTunnel = vi.fn().mockResolvedValue(undefined);
const mockRunMultiTunnel = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/tunnel-session.js", () => ({
  runSingleTunnel: (...args: any[]) => mockRunSingleTunnel(...args),
  runMultiTunnel: (...args: any[]) => mockRunMultiTunnel(...args),
  setupShutdown: vi.fn(),
}));

const mockResolveEndpoints = vi.fn();
vi.mock("../lib/endpoint-resolver.js", () => ({
  resolveEndpoints: (...args: any[]) => mockResolveEndpoints(...args),
}));

const mockConnectTunnel = vi.fn().mockResolvedValue({
  channel: {},
  heartbeatInterval: null,
  disconnect: vi.fn(),
});
vi.mock("../lib/cable-client.js", () => ({
  connectTunnel: (...args: any[]) => mockConnectTunnel(...args),
  connectMultiTunnel: vi.fn(),
}));

vi.mock("../lib/forwarder.js", () => ({
  forwardToLocalhost: vi.fn().mockResolvedValue({
    statusCode: 200,
    statusText: "OK",
    responseTimeMs: 10,
  }),
}));

const mockLoginCommand = vi.fn();
vi.mock("./login.js", () => ({
  loginCommand: (...args: any[]) => mockLoginCommand(...args),
}));

import { endpointsCommand } from "./endpoints.js";
import { startCommand } from "./start.js";
import { getStoredHost, resolveToken } from "../lib/config.js";
import * as ui from "../lib/ui.js";

const STUB_IDENTITY = {
  user: { id: "usr_1", email: "dev@example.com", name: "Dev" },
  account: { id: "acct_1", name: "Example", plan: "pro" },
};

function stubEndpoint(overrides: Record<string, any> = {}) {
  return {
    id: "ep_123",
    name: "Test Endpoint",
    custom_id: null,
    webhook_url: "https://listen.catchhook.app/hooks/ep_123",
    tunnel_active: false,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

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

  it("exits with error if no token is available", async () => {
    vi.mocked(resolveToken).mockReturnValue({ token: undefined, source: "none" });

    await expect(endpointsCommand({})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated")
    );
  });

  it("lists endpoints when authenticated", async () => {
    vi.mocked(resolveToken).mockReturnValue({ token: "chk_test", source: "stored" });
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockListEndpoints.mockResolvedValue({
      data: [stubEndpoint()],
    });

    await endpointsCommand({});
    const allOutput = consoleSpy.mock.calls.map((c) => c[0] || "").join("\n");
    expect(allOutput).toContain("Test Endpoint");
    expect(allOutput).toContain("ep_123");
  });

  it("shows info message when no endpoints found", async () => {
    vi.mocked(resolveToken).mockReturnValue({ token: "chk_test", source: "stored" });
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockListEndpoints.mockResolvedValue({ data: [] });

    await endpointsCommand({});

    expect(ui.info).toHaveBeenCalledWith(
      expect.stringContaining("No endpoints found")
    );
  });

  it("handles API errors gracefully", async () => {
    vi.mocked(resolveToken).mockReturnValue({ token: "chk_test", source: "stored" });
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockListEndpoints.mockRejectedValue(new Error("Network error"));

    await expect(endpointsCommand({})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith("Network error");
  });

  it("uses host from options if provided", async () => {
    vi.mocked(resolveToken).mockReturnValue({ token: "chk_test", source: "stored" });
    vi.mocked(getStoredHost).mockReturnValue("stored.host");
    mockListEndpoints.mockResolvedValue({ data: [] });

    await endpointsCommand({ host: "custom.host:3100" });

    expect(mockListEndpoints).toHaveBeenCalled();
  });
});

describe("startCommand", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
  });

  it("requires endpoint selection in authenticated mode", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    await expect(startCommand(undefined, {})).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("--endpoint")
    );
  });

  it("starts anonymous tunnel with endpoint id and key", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    startCommand("ep_abc", { key: "tkey_abc", port: "4000" });
    await new Promise((r) => setTimeout(r, 100));

    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "anonymous",
        endpointId: "ep_abc",
        targetUrl: "http://localhost:4000",
      })
    );
    expect(mockRunSingleTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "anonymous",
        tunnelKey: "tkey_abc",
        endpointId: "ep_abc",
      }),
      "http://localhost:4000",
      null,
      expect.objectContaining({ id: "ep_abc" }),
      expect.any(Function)
    );
  });

  it("defaults port to 3000 for anonymous tunnel", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    startCommand("ep_abc", { key: "tkey_abc" });
    await new Promise((r) => setTimeout(r, 100));

    expect(ui.connectionInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost:3000",
      })
    );
  });

  it("exits with error when anonymous mode has no endpoint id", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);

    await expect(startCommand(undefined, { key: "tkey_abc" })).rejects.toThrow("process.exit");
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("Endpoint ID is required")
    );
  });

  it("starts single authenticated tunnel", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockEnsureAuthenticatedToken.mockResolvedValue({
      token: "chk_test",
      identity: STUB_IDENTITY,
    });
    const ep = stubEndpoint();
    mockResolveEndpoints.mockResolvedValue([ep]);

    startCommand(undefined, { endpoint: ["ep_123"] });
    await new Promise((r) => setTimeout(r, 100));

    expect(mockEnsureAuthenticatedToken).toHaveBeenCalled();
    expect(mockResolveEndpoints).toHaveBeenCalled();
    expect(mockRunSingleTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "authenticated", token: "chk_test", endpointId: "ep_123" }),
      "http://localhost:3000",
      expect.any(Object),
      ep,
      expect.any(Function)
    );
  });

  it("starts multi-endpoint tunnel with --all flag", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockEnsureAuthenticatedToken.mockResolvedValue({
      token: "chk_test",
      identity: STUB_IDENTITY,
    });
    const endpoints = [
      stubEndpoint({ id: "ep_1", name: "Endpoint 1" }),
      stubEndpoint({ id: "ep_2", name: "Endpoint 2" }),
    ];
    mockResolveEndpoints.mockResolvedValue(endpoints);

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
    expect(mockRunMultiTunnel).toHaveBeenCalledWith(
      "chk_test",
      "catchhook.app",
      "http://localhost:3000",
      expect.any(Object),
      endpoints,
      expect.any(Function)
    );
  });

  it("uses custom host from options", async () => {
    vi.mocked(getStoredHost).mockReturnValue(undefined);
    mockEnsureAuthenticatedToken.mockResolvedValue({
      token: "chk_test",
      identity: STUB_IDENTITY,
    });
    mockResolveEndpoints.mockResolvedValue([stubEndpoint()]);

    startCommand(undefined, { endpoint: ["ep_123"], host: "custom.host:3100" });
    await new Promise((r) => setTimeout(r, 100));

    expect(mockEnsureAuthenticatedToken).toHaveBeenCalledWith(
      "custom.host:3100",
      expect.any(Object),
      expect.any(Function)
    );
  });
});
