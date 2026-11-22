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
  /** Dedicated secret for GET /health/deep. Not the query API token. */
  HEALTH_PROBE_TOKEN?: string;
  /** Optional 64-hex profile used by an HTTP upstream probe. Not a customer identity. */
  HEALTH_PROBE_PUBKEY?: string;
  /** Optional 64-hex event id used when no profile fixture is set. */
  HEALTH_PROBE_EVENT_ID?: string;
  HEALTH_PROBE_LIMIT?: string;
  HEALTH_PROBE_WINDOW_MS?: string;
  HEALTH_PROBE_CACHE_MS?: string;
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
