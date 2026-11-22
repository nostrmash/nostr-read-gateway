import { hex64 } from "./frames";
import { routeProbe, type RouteDecision } from "./router";
import type { GatewayEnv, QueryDependencies, QueryInput, Upstream } from "./types";

/** Synthetic profile key. It is not a person's identity. A 404 is an empty success. */
export const SYNTHETIC_PROBE_PUBKEY = "0".repeat(64);

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CACHE_MS = 15_000;

interface CachedProbe {
  key: string;
  expiresAt: number;
  status: number;
  body: Record<string, unknown>;
}

let cache: CachedProbe | null = null;
let inflight: { key: string; promise: Promise<CachedProbe> } | null = null;
let acceptedAt: number[] = [];

export function resetDeepHealthState(): void {
  cache = null;
  inflight = null;
  acceptedAt = [];
}

export function probeInput(
  upstream: Upstream,
  env: GatewayEnv,
  trace: string,
  deadline: number,
): QueryInput {
  if (upstream.type !== "nostrmash_http") {
    return { requestType: "net_stats", traceId: trace, deadline };
  }
  const pubkey = hex64(env.HEALTH_PROBE_PUBKEY);
  const eventId = hex64(env.HEALTH_PROBE_EVENT_ID);
  if (!pubkey && eventId) {
    return {
      requestType: "events",
      params: { event_ids: [eventId] },
      traceId: trace,
      deadline,
    };
  }
  return {
    requestType: "user_profile",
    params: { pubkey: pubkey ?? SYNTHETIC_PROBE_PUBKEY },
    traceId: trace,
    deadline,
  };
}

function integerSetting(value: string | undefined, fallback: number, max: number): number {
  const raw = value?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(0, Number(raw)));
}

function cacheKey(env: GatewayEnv): string {
  return `${env.UPSTREAMS ?? ""}|${env.HEALTH_PROBE_PUBKEY ?? ""}|${env.HEALTH_PROBE_EVENT_ID ?? ""}`;
}

function permit(now: number, env: GatewayEnv): boolean {
  const limit = integerSetting(env.HEALTH_PROBE_LIMIT, DEFAULT_LIMIT, 1_000);
  const windowMs = Math.max(
    1_000,
    integerSetting(env.HEALTH_PROBE_WINDOW_MS, DEFAULT_WINDOW_MS, 3_600_000) || DEFAULT_WINDOW_MS,
  );
  acceptedAt = acceptedAt.filter((at) => now - at < windowMs);
  if (acceptedAt.length >= limit) return false;
  acceptedAt.push(now);
  return true;
}

function outcome(decision: RouteDecision): { status: number; body: Record<string, unknown> } {
  if (!decision.ok) {
    const misconfigured = decision.code === "no_provider_supports_request";
    return {
      status: misconfigured ? 503 : decision.status === 504 ? 503 : 503,
      body: {
        status: misconfigured ? "misconfigured" : "down",
        code: decision.code,
        attempts: decision.attempts.map((attempt) => ({
          upstream: attempt.upstream,
          type: attempt.type,
          requestType: attempt.requestType,
          kind: attempt.kind,
        })),
      },
    };
  }
  const empty = !decision.messages.some(
    (message) => Array.isArray(message) && message[0] === "EVENT",
  );
  const requestType = decision.attempts.at(-1)?.requestType ?? "net_stats";
  return {
    status: 200,
    body: {
      status: "ok",
      upstream: decision.upstream.name,
      requestType,
      empty,
      data: empty ? "not_proven" : "present",
      fallbackCount: decision.fallbackCount,
      limitation: empty
        ? "An empty result shows the upstream completed the probe. It does not show that the upstream has indexed data."
        : null,
    },
  };
}

export async function runDeepHealth(input: {
  env: GatewayEnv;
  upstreams: Upstream[];
  deps: QueryDependencies;
  trace: string;
  now: number;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = cacheKey(input.env);
  const ttl = integerSetting(input.env.HEALTH_PROBE_CACHE_MS, DEFAULT_CACHE_MS, 60_000);
  if (ttl > 0 && cache && cache.key === key && cache.expiresAt > input.now) {
    return { status: cache.status, body: { ...cache.body, cached: true } };
  }
  if (!permit(input.now, input.env)) {
    return {
      status: 429,
      body: { status: "down", code: "rate_limited", error: "Probe rate limit exceeded" },
    };
  }
  if (inflight && inflight.key === key) {
    const shared = await inflight.promise;
    return { status: shared.status, body: { ...shared.body, cached: true } };
  }
  const promise = (async (): Promise<CachedProbe> => {
    const decision = await routeProbe(
      input.upstreams,
      (upstream) => probeInput(upstream, input.env, input.trace, input.now + 3_000),
      input.deps,
    );
    const result = outcome(decision);
    return { key, expiresAt: input.now + ttl, status: result.status, body: result.body };
  })();
  inflight = { key, promise };
  try {
    const result = await promise;
    if (ttl > 0) cache = result;
    return { status: result.status, body: { ...result.body, cached: false } };
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}
