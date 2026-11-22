import { queryNostrMashHttp } from "./providers/nostrmash-http";
import { querySocket } from "./providers/socket";
import type { ProviderResult, QueryDependencies, QueryInput, Upstream } from "./types";

export interface RouteHit {
  upstream: string;
  type: string;
  requestType: string;
  kind: ProviderResult["kind"];
  latencyMs: number;
}

export type RouteDecision =
  | {
      ok: true;
      upstream: Upstream;
      messages: unknown[];
      fallbackCount: number;
      latencyMs: number;
      attempts: RouteHit[];
    }
  | { ok: false; status: number; code: string; error: string; attempts: RouteHit[] };

function ordered(upstreams: Upstream[]): Upstream[] {
  return [...upstreams].sort(
    (left, right) => left.priority - right.priority || left.name.localeCompare(right.name),
  );
}

async function queryOne(
  upstream: Upstream,
  input: QueryInput,
  deps: QueryDependencies,
): Promise<ProviderResult> {
  if (upstream.type === "nostrmash_http") {
    return queryNostrMashHttp(upstream.url, input, deps.fetchImpl ?? fetch);
  }
  return querySocket(upstream, input, deps.webSocket ?? WebSocket);
}

export async function routeProbe(
  upstreams: Upstream[],
  plan: (upstream: Upstream) => QueryInput,
  deps: QueryDependencies,
): Promise<RouteDecision> {
  const attempts: RouteHit[] = [];
  let fallbackCount = 0;
  const started = Date.now();
  for (const upstream of ordered(upstreams)) {
    const input = plan(upstream);
    const attemptStarted = Date.now();
    const result = await queryOne(upstream, input, deps);
    attempts.push({
      upstream: upstream.name,
      type: upstream.type,
      requestType: input.requestType,
      kind: result.kind,
      latencyMs: Date.now() - attemptStarted,
    });
    if ((result.kind === "complete" || result.kind === "empty") && result.messages) {
      return {
        ok: true,
        upstream,
        messages: result.messages,
        fallbackCount,
        latencyMs: Date.now() - started,
        attempts,
      };
    }
    if (result.kind !== "unsupported") fallbackCount += 1;
  }
  const supported = attempts.filter((attempt) => attempt.kind !== "unsupported");
  if (supported.length === 0) {
    return {
      ok: false,
      status: 501,
      code: "no_provider_supports_request",
      error: "No configured upstream supports this request type",
      attempts,
    };
  }
  const timeouts = supported.every((attempt) => attempt.kind === "timeout");
  const malformed = supported.every((attempt) => attempt.kind === "malformed");
  return {
    ok: false,
    status: timeouts ? 504 : 502,
    code: timeouts ? "upstream_timeout" : malformed ? "malformed_upstream" : "upstream_failed",
    error: timeouts
      ? "Configured upstreams timed out"
      : "Configured upstreams could not answer the probe",
    attempts,
  };
}

export async function routeQuery(
  upstreams: Upstream[],
  input: QueryInput,
  deps: QueryDependencies,
): Promise<RouteDecision> {
  const attempts: RouteHit[] = [];
  let fallbackCount = 0;
  const started = Date.now();
  for (const upstream of ordered(upstreams)) {
    const attemptStarted = Date.now();
    const result = await queryOne(upstream, input, deps);
    attempts.push({
      upstream: upstream.name,
      type: upstream.type,
      requestType: input.requestType,
      kind: result.kind,
      latencyMs: Date.now() - attemptStarted,
    });
    if ((result.kind === "complete" || result.kind === "empty") && result.messages) {
      return {
        ok: true,
        upstream,
        messages: result.messages,
        fallbackCount,
        latencyMs: Date.now() - started,
        attempts,
      };
    }
    if (result.kind !== "unsupported") fallbackCount += 1;
  }
  const supported = attempts.filter((attempt) => attempt.kind !== "unsupported");
  if (supported.length === 0) {
    return {
      ok: false,
      status: 501,
      code: "no_provider_supports_request",
      error: "No configured upstream supports this request type",
      attempts,
    };
  }
  const timeouts = supported.every((attempt) => attempt.kind === "timeout");
  return {
    ok: false,
    status: timeouts ? 504 : 502,
    code: timeouts ? "upstream_timeout" : "upstream_failed",
    error: timeouts ? "Configured upstreams timed out" : "Configured upstreams could not answer",
    attempts,
  };
}
