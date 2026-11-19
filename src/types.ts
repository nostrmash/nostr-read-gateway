export type UpstreamType = "primal_ws" | "nostrmash_ws" | "nostrmash_http";

export interface Upstream {
  name: string;
  type: UpstreamType;
  url: string;
  priority: number;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  httpTimeoutMs: number;
}

export type ResultKind =
  | "complete"
  | "empty"
  | "unsupported"
  | "incomplete"
  | "malformed"
  | "timeout"
  | "connection_failed"
  | "upstream_error";

export interface ProviderResult {
  kind: ResultKind;
  messages?: unknown[];
  reason?: string;
}

export interface QueryInput {
  requestType: string;
  params?: Record<string, unknown>;
  traceId: string;
  deadline: number;
}

export interface GatewayEnv {
  UPSTREAMS?: string;
  ENVIRONMENT?: string;
  REQUIRE_AUTH?: string;
  READ_GATEWAY_TOKEN?: string;
  GATEWAY_BUDGET_MS?: string;
}

export interface QueryDependencies {
  fetchImpl?: typeof fetch;
  webSocket?: new (url: string) => GatewaySocket;
  now?: () => number;
}

export interface GatewaySocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}
