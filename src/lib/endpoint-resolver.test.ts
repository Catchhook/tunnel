import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ui.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockListEndpoints = vi.fn();
const mockCreateEndpoint = vi.fn();
vi.mock("./api-client.js", () => ({
  ApiClient: class MockApiClient {
    listEndpoints = mockListEndpoints;
    createEndpoint = mockCreateEndpoint;
  },
}));

import { resolveEndpoints } from "./endpoint-resolver.js";
import { ApiClient } from "./api-client.js";
import * as ui from "./ui.js";

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

describe("resolveEndpoints", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
    client = new ApiClient("chk_test", "catchhook.app");
  });

  describe("--all flag", () => {
    it("returns all endpoints", async () => {
      const endpoints = [
        stubEndpoint({ id: "ep_1", name: "Endpoint 1" }),
        stubEndpoint({ id: "ep_2", name: "Endpoint 2" }),
      ];
      mockListEndpoints.mockResolvedValue({ data: endpoints });

      const result = await resolveEndpoints(client, { all: true }, "http://localhost:3000");
      expect(result).toEqual(endpoints);
    });

    it("exits when no endpoints exist", async () => {
      mockListEndpoints.mockResolvedValue({ data: [] });

      await expect(
        resolveEndpoints(client, { all: true }, "http://localhost:3000")
      ).rejects.toThrow("process.exit");
      expect(ui.error).toHaveBeenCalledWith(expect.stringContaining("No endpoints found"));
    });
  });

  describe("--endpoint flag", () => {
    it("resolves endpoints by id", async () => {
      const ep = stubEndpoint({ id: "ep_1", name: "Endpoint 1" });
      mockListEndpoints.mockResolvedValue({ data: [ep, stubEndpoint({ id: "ep_2" })] });

      const result = await resolveEndpoints(client, { endpoint: ["ep_1"] }, "http://localhost:3000");
      expect(result).toEqual([ep]);
    });

    it("resolves endpoints by custom_id", async () => {
      const ep = stubEndpoint({ id: "ep_1", custom_id: "stripe", name: "Stripe" });
      mockListEndpoints.mockResolvedValue({ data: [ep] });

      const result = await resolveEndpoints(client, { endpoint: ["stripe"] }, "http://localhost:3000");
      expect(result).toEqual([ep]);
    });

    it("exits when endpoint is not found", async () => {
      mockListEndpoints.mockResolvedValue({ data: [] });

      await expect(
        resolveEndpoints(client, { endpoint: ["ep_missing"] }, "http://localhost:3000")
      ).rejects.toThrow("process.exit");
      expect(ui.error).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("deduplicates repeated endpoint ids", async () => {
      const ep = stubEndpoint({ id: "ep_1" });
      mockListEndpoints.mockResolvedValue({ data: [ep] });

      const result = await resolveEndpoints(client, { endpoint: ["ep_1", "ep_1"] }, "http://localhost:3000");
      expect(result).toEqual([ep]);
      expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("Duplicate"));
    });

    it("resolves multiple distinct endpoints", async () => {
      const ep1 = stubEndpoint({ id: "ep_1", custom_id: "stripe" });
      const ep2 = stubEndpoint({ id: "ep_2", custom_id: "github" });
      mockListEndpoints.mockResolvedValue({ data: [ep1, ep2] });

      const result = await resolveEndpoints(client, { endpoint: ["stripe", "ep_2"] }, "http://localhost:3000");
      expect(result).toEqual([ep1, ep2]);
    });
  });

  describe("--new flag", () => {
    it("creates a new endpoint", async () => {
      const ep = stubEndpoint({ id: "ep_new", name: "Tunnel -> http://localhost:3000" });
      mockCreateEndpoint.mockResolvedValue({ data: ep });

      const result = await resolveEndpoints(client, { new: true }, "http://localhost:3000");
      expect(result).toEqual([ep]);
      expect(ui.success).toHaveBeenCalledWith(expect.stringContaining("Created endpoint"));
    });
  });

  describe("no option selected", () => {
    it("exits with error", async () => {
      await expect(
        resolveEndpoints(client, {}, "http://localhost:3000")
      ).rejects.toThrow("process.exit");
      expect(ui.error).toHaveBeenCalledWith("No endpoint option selected.");
    });
  });
});
