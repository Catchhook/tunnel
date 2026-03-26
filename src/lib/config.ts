import Conf from "conf";

interface CatchHookConfig {
  token?: string;
  host?: string;
}

const config = new Conf<CatchHookConfig>({
  projectName: "catchhook",
  schema: {
    token: { type: "string" },
    host: { type: "string" },
  },
});

export function getStoredToken(): string | undefined {
  return config.get("token");
}

export function setStoredToken(token: string): void {
  config.set("token", token);
}

export function getStoredHost(): string | undefined {
  return config.get("host");
}

export function setStoredHost(host: string): void {
  config.set("host", host);
}

export function clearConfig(): void {
  config.clear();
}

export function getConfigPath(): string {
  return config.path;
}
