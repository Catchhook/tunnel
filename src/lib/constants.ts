// Production default — the ONLY host baked into the package
export const DEFAULT_HOST = "catchhook.app";

// Runtime override via env var or --host flag (never baked in)
export const getHost = (): string =>
  process.env.CATCHHOOK_HOST || DEFAULT_HOST;

export const getProtocol = (host: string): string =>
  host.includes("localhost") ? "http" : "https";

export const getWsProtocol = (host: string): string =>
  host.includes("localhost") ? "ws" : "wss";

export const getBaseUrl = (host?: string): string => {
  const h = host || getHost();
  return `${getProtocol(h)}://${h}`;
};
