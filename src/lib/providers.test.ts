import { describe, it, expect } from "vitest";
import {
  getProviderPreset,
  resolveTargetUrl,
  getReplayWarning,
  VALID_PROVIDERS,
} from "./providers.js";

describe("getProviderPreset", () => {
  it("returns GitHub preset", () => {
    const preset = getProviderPreset("github");
    expect(preset).toBeDefined();
    expect(preset!.displayName).toBe("GitHub");
    expect(preset!.defaultPath).toBe("/webhooks/github");
  });

  it("returns Stripe preset", () => {
    const preset = getProviderPreset("stripe");
    expect(preset).toBeDefined();
    expect(preset!.displayName).toBe("Stripe");
  });

  it("returns undefined for unknown provider", () => {
    expect(getProviderPreset("unknown")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(getProviderPreset("GitHub")).toBeDefined();
    expect(getProviderPreset("STRIPE")).toBeDefined();
  });
});

describe("VALID_PROVIDERS", () => {
  it("includes github and stripe", () => {
    expect(VALID_PROVIDERS).toContain("github");
    expect(VALID_PROVIDERS).toContain("stripe");
  });
});

describe("resolveTargetUrl", () => {
  const githubPreset = getProviderPreset("github")!;

  it("appends provider path when target is undefined", () => {
    expect(resolveTargetUrl(undefined, undefined, githubPreset)).toBe(
      "http://localhost:3000/webhooks/github"
    );
  });

  it("appends provider path when target is a port number", () => {
    expect(resolveTargetUrl("4000", undefined, githubPreset)).toBe(
      "http://localhost:4000/webhooks/github"
    );
  });

  it("uses --port when target is undefined", () => {
    expect(resolveTargetUrl(undefined, "8080", githubPreset)).toBe(
      "http://localhost:8080/webhooks/github"
    );
  });

  it("uses full URL as-is (no path appended)", () => {
    expect(resolveTargetUrl("http://localhost:4000/foo", undefined, githubPreset)).toBe(
      "http://localhost:4000/foo"
    );
  });

  it("defaults to port 3000 without provider", () => {
    expect(resolveTargetUrl(undefined, undefined, undefined)).toBe(
      "http://localhost:3000"
    );
  });

  it("uses port without provider", () => {
    expect(resolveTargetUrl("5000", undefined, undefined)).toBe(
      "http://localhost:5000"
    );
  });
});

describe("getReplayWarning", () => {
  it("returns warning for dangerous GitHub event", () => {
    const warning = getReplayWarning("github", "workflow_run");
    expect(warning).toBeDefined();
    expect(warning).toContain("CI pipelines");
  });

  it("returns warning for action-qualified event via base-event fallback", () => {
    const warning = getReplayWarning("github", "workflow_run.completed");
    expect(warning).toBeDefined();
    expect(warning).toContain("CI pipelines");
  });

  it("returns undefined for safe events", () => {
    expect(getReplayWarning("github", "push")).toBeUndefined();
  });

  it("returns undefined for nil provider", () => {
    expect(getReplayWarning(undefined, "push")).toBeUndefined();
  });

  it("returns undefined for nil event_type", () => {
    expect(getReplayWarning("github", undefined)).toBeUndefined();
  });

  it("returns warning for dangerous Stripe event", () => {
    const warning = getReplayWarning("stripe", "checkout.session.completed");
    expect(warning).toBeDefined();
    expect(warning).toContain("fulfillment");
  });

  it("returns undefined for unknown provider", () => {
    expect(getReplayWarning("unknown", "anything")).toBeUndefined();
  });
});
