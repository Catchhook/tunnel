export interface ProviderPreset {
  name: string;
  displayName: string;
  defaultPath: string;
  suggestedEvents: string[];
  setupInstructions: string;
  signatureHeaderName: string;
  dangerousReplayEvents: Record<string, string>;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  github: {
    name: "github",
    displayName: "GitHub",
    defaultPath: "/webhooks/github",
    suggestedEvents: ["push", "pull_request", "workflow_run", "issues", "release"],
    setupInstructions: "Repo > Settings > Webhooks > Add webhook",
    signatureHeaderName: "X-Hub-Signature-256",
    dangerousReplayEvents: {
      "workflow_run": "Replaying workflow_run may retrigger CI pipelines.",
      "deployment": "Replaying deployment events may trigger new deployments.",
      "release": "Replaying release events may trigger release automation.",
      "deployment_status": "Replaying deployment_status may trigger downstream deploy hooks.",
      "check_run": "Replaying check_run may re-execute CI checks.",
    },
  },
  stripe: {
    name: "stripe",
    displayName: "Stripe",
    defaultPath: "/webhooks/stripe",
    suggestedEvents: [
      "checkout.session.completed",
      "payment_intent.succeeded",
      "customer.subscription.updated",
      "invoice.paid",
      "charge.failed",
    ],
    setupInstructions: "Stripe Dashboard > Developers > Webhooks > Add endpoint",
    signatureHeaderName: "Stripe-Signature",
    dangerousReplayEvents: {
      "checkout.session.completed": "Replaying may duplicate fulfillment.",
      "invoice.paid": "Replaying may trigger duplicate payment processing.",
      "charge.succeeded": "Replaying may duplicate order completion logic.",
      "payment_intent.succeeded": "Replaying may trigger duplicate fulfillment.",
      "customer.subscription.created": "Replaying may create duplicate subscriptions.",
    },
  },
};

export const VALID_PROVIDERS = Object.keys(PROVIDER_PRESETS);

export function getProviderPreset(name: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[name.toLowerCase()];
}

export function resolveTargetUrl(
  target: string | undefined,
  port: string | undefined,
  providerPreset: ProviderPreset | undefined
): string {
  if (target && target.startsWith("http")) {
    return target;
  }

  const resolvedPort = target || port || "3000";
  const base = `http://localhost:${resolvedPort}`;

  if (providerPreset) {
    return `${base}${providerPreset.defaultPath}`;
  }

  return base;
}

export function getReplayWarning(
  providerName: string | null | undefined,
  eventType: string | null | undefined
): string | undefined {
  if (!providerName || !eventType) return undefined;
  const preset = getProviderPreset(providerName);
  if (!preset) return undefined;

  const baseEventType = eventType.split(".").slice(0, -1).join(".") || eventType;
  return preset.dangerousReplayEvents[eventType] || preset.dangerousReplayEvents[baseEventType];
}
