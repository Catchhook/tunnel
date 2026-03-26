import { getBaseUrl } from "./constants.js";

export interface AuthVerifyResponse {
  data: {
    user: { id: string; email: string; name: string };
    account: { id: string; name: string; plan: string };
  };
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
      throw new Error(`API error ${res.status}: ${text || res.statusText}`);
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
    throw new Error(`API error ${res.status}: ${text || res.statusText}`);
  }
}
