import { getBaseUrl } from "./constants.js";

export interface AuthIdentity {
  user: { id: string; email: string; name: string };
  account: { id: string; name: string; plan: string };
}

export interface AuthVerifyResponse {
  data: AuthIdentity;
}

export interface EndpointData {
  id: string;
  name: string;
  custom_id: string | null;
  webhook_url: string;
  tunnel_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EndpointsResponse {
  data: EndpointData[];
}

export interface TicketResponse {
  ticket: string;
  expires_in: number;
  endpoint_id?: string;
}

export interface CliAuthExchangeResponse {
  data: {
    token: string;
    user: { id: string; email: string; name: string };
    account: { id: string; name: string; plan: string };
  };
}

export class ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(token: string, host?: string) {
    this.token = token;
    this.baseUrl = getBaseUrl(host);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const summary = text.length > 200 ? text.slice(0, 200) + "…" : text;
      throw new Error(`API error ${res.status}: ${summary || res.statusText}`);
    }

    return res.json() as Promise<T>;
  }

  async verify(): Promise<AuthVerifyResponse> {
    return this.request("GET", "/api/v1/auth/verify");
  }

  async listEndpoints(): Promise<EndpointsResponse> {
    return this.request("GET", "/api/v1/endpoints");
  }

  async createEndpoint(name: string): Promise<{ data: EndpointData }> {
    return this.request("POST", "/api/v1/endpoints", { endpoint: { name } });
  }

  async getTunnelTicket(endpointId: string): Promise<TicketResponse> {
    return this.request("POST", "/api/v1/tunnel/connect", { endpoint_id: endpointId });
  }

  async reportDelivery(data: {
    webhook_request_id: string;
    endpoint_id: string;
    status_code: number;
    response_time_ms: number;
    target_url: string;
    response_message?: string;
  }): Promise<void> {
    await this.request("POST", "/api/v1/tunnel/delivery_reports", data);
  }

  async getMissedRequests(endpointIds: string[], since: string): Promise<MissedWebhookData[]> {
    const params = new URLSearchParams();
    params.set("since", since);
    for (const id of endpointIds) {
      params.append("endpoint_ids[]", id);
    }
    const resp = await this.request<{ data: RawMissedWebhookData[] }>(
      "GET", `/api/v1/tunnel/missed?${params.toString()}`
    );
    return resp.data.map(deserializeMissedWebhook);
  }

  async getUndeliveredRequests(endpointIds: string[], minutes?: number): Promise<MissedWebhookData[]> {
    const params = new URLSearchParams();
    for (const id of endpointIds) {
      params.append("endpoint_ids[]", id);
    }
    if (minutes !== undefined) {
      params.set("minutes", String(minutes));
    }
    const resp = await this.request<{ data: RawMissedWebhookData[] }>(
      "GET", `/api/v1/tunnel/undelivered?${params.toString()}`
    );
    return resp.data.map(deserializeMissedWebhook);
  }
}

// Unauthenticated call for anonymous tunnel_key exchange
export async function getAnonymousTunnelTicket(
  tunnelKey: string,
  host?: string
): Promise<TicketResponse> {
  const baseUrl = getBaseUrl(host);
  const res = await fetch(`${baseUrl}/api/v1/tunnel/connect_anonymous`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tunnel_key: tunnelKey }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Invalid or expired tunnel key. The temporary endpoint may have expired.");
    }
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }

  return res.json() as Promise<TicketResponse>;
}

export async function reportAnonymousDelivery(
  data: {
    tunnel_key: string;
    webhook_request_id: string;
    endpoint_id: string;
    status_code: number;
    response_time_ms: number;
    target_url: string;
    response_message?: string;
  },
  host?: string
): Promise<void> {
  const baseUrl = getBaseUrl(host);
  const res = await fetch(`${baseUrl}/api/v1/tunnel/delivery_reports_anonymous`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const summary = text.length > 200 ? text.slice(0, 200) + "…" : text;
    throw new Error(`API error ${res.status}: ${summary || res.statusText}`);
  }
}

interface RawMissedWebhookData {
  type: string;
  id: string;
  endpoint_id: string;
  method: string;
  path: string | null;
  headers: Record<string, string>;
  body: string | null;
  body_encoding: string;
  body_size: number;
  query_parameters: Record<string, string>;
  content_type: string | null;
  ip_address: string | null;
  requested_at: string;
}

export interface MissedWebhookData {
  type: string;
  id: string;
  endpoint_id: string;
  method: string;
  path: string | null;
  headers: Record<string, string>;
  body: Buffer | null;
  body_encoding: string;
  body_size: number;
  query_parameters: Record<string, string>;
  content_type: string | null;
  ip_address: string | null;
  requested_at: string;
}

function deserializeMissedWebhook(raw: RawMissedWebhookData): MissedWebhookData {
  let body: Buffer | null = null;
  if (raw.body && raw.body_encoding === "base64") {
    body = Buffer.from(raw.body, "base64");
  } else if (raw.body) {
    body = Buffer.from(raw.body);
  }
  return { ...raw, body };
}

export async function getAnonymousMissedRequests(
  tunnelKey: string,
  since: string,
  host?: string
): Promise<MissedWebhookData[]> {
  const baseUrl = getBaseUrl(host);
  const params = new URLSearchParams({
    tunnel_key: tunnelKey,
    since,
  });

  const res = await fetch(`${baseUrl}/api/v1/tunnel/missed_anonymous?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Invalid or expired tunnel key.");
    }
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }

  const resp = (await res.json()) as { data: RawMissedWebhookData[] };
  return resp.data.map(deserializeMissedWebhook);
}

export async function exchangeCliAuthCode(
  code: string,
  host?: string
): Promise<CliAuthExchangeResponse> {
  const baseUrl = getBaseUrl(host);
  const res = await fetch(`${baseUrl}/api/v1/cli_auth/exchange`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ code }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Auth code is invalid or expired. Generate a new one and try again.");
    }
    const text = await res.text().catch(() => "");
    const summary = text.length > 200 ? text.slice(0, 200) + "…" : text;
    throw new Error(`API error ${res.status}: ${summary || res.statusText}`);
  }

  return res.json() as Promise<CliAuthExchangeResponse>;
}
