import { allowLocalUpstreams, parseUpstreams } from "./config";
import { isRequestType } from "./request-types";
import { routeQuery } from "./router";
import type { GatewayEnv, QueryDependencies } from "./types";

const MAX_BODY = 256 * 1024;

function traceId(request: Request): string {
  const raw = request.headers.get("x-request-id")?.trim() ?? "";
  if (/^[A-Za-z0-9._:-]{1,80}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

function headers(trace: string, extra?: Record<string, string>): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-request-id",
    "access-control-expose-headers":
      "x-request-id, x-upstream, x-upstream-type, x-fallback-count, x-response-time",
    "x-request-id": trace,
    ...extra,
  });
}

function json(
  status: number,
  body: unknown,
  trace: string,
  extra?: Record<string, string>,
): Response {
  const responseHeaders = headers(trace, extra);
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function tokenMatches(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length === right.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

function authorize(request: Request, env: GatewayEnv): Response | null {
  const token = env.READ_GATEWAY_TOKEN?.trim() ?? "";
  if (env.REQUIRE_AUTH === "true" && token.length === 0) {
    return json(
      503,
      { error: "READ_GATEWAY_TOKEN is required", code: "auth_not_configured" },
      traceId(request),
    );
  }
  if (token.length === 0) return null;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!tokenMatches(bearer, token)) {
    return json(401, { error: "Authentication failed", code: "unauthorized" }, traceId(request));
  }
  return null;
}

async function readBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > MAX_BODY) {
    throw new Error("body_too_large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > MAX_BODY) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function deepHealth(
  parsed: ReturnType<typeof parseUpstreams>,
  deps: QueryDependencies,
  trace: string,
): Promise<Response> {
  if (!parsed.ok) {
    return json(
      503,
      {
        status: "misconfigured",
        error: parsed.reason,
        code:
          parsed.reason === "upstreams_not_configured"
            ? "upstreams_not_configured"
            : "invalid_upstream_configuration",
      },
      trace,
    );
  }
  const decision = await routeQuery(
    parsed.upstreams,
    { requestType: "net_stats", traceId: trace, deadline: Date.now() + 3_000 },
    deps,
  );
  if (!decision.ok) {
    return json(
      503,
      { status: "down", code: decision.code, attempts: decision.attempts.length },
      trace,
    );
  }
  return json(
    200,
    {
      status: "ok",
      upstream: decision.upstream.name,
      empty: !decision.messages.some((message) => Array.isArray(message) && message[0] === "EVENT"),
      fallbackCount: decision.fallbackCount,
    },
    trace,
  );
}

function budget(env: GatewayEnv): number {
  const parsed = Number(env.GATEWAY_BUDGET_MS);
  if (!Number.isInteger(parsed)) return 20_000;
  return Math.min(25_000, Math.max(200, parsed));
}

export async function handleFetch(
  request: Request,
  env: GatewayEnv,
  deps: QueryDependencies = {},
): Promise<Response> {
  const trace = traceId(request);
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: headers(trace) });
  const parsed = parseUpstreams(env.UPSTREAMS, allowLocalUpstreams(env.ENVIRONMENT));
  if (request.method === "GET" && path === "/health") {
    if (!parsed.ok)
      return json(
        503,
        {
          status: "misconfigured",
          error: parsed.reason,
          code:
            parsed.reason === "upstreams_not_configured"
              ? "upstreams_not_configured"
              : "invalid_upstream_configuration",
        },
        trace,
      );
    return json(
      200,
      {
        status: "ok",
        providers: parsed.upstreams
          .map((upstream) => ({
            name: upstream.name,
            type: upstream.type,
            priority: upstream.priority,
          }))
          .sort(
            (left, right) => left.priority - right.priority || left.name.localeCompare(right.name),
          ),
      },
      trace,
    );
  }
  if (request.method === "GET" && path === "/health/deep") {
    return deepHealth(parsed, deps, trace);
  }
  if (request.method !== "POST" || (path !== "/" && path !== "/query")) {
    return json(404, { error: "not_found", code: "not_found" }, trace);
  }
  const denied = authorize(request, env);
  if (denied) return denied;
  if (!parsed.ok) {
    const code =
      parsed.reason === "upstreams_not_configured"
        ? "upstreams_not_configured"
        : "invalid_upstream_configuration";
    return json(503, { error: parsed.reason, code }, trace);
  }
  try {
    const bytes = await readBody(request);
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try {
      body = text.trim() === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      return json(400, { error: "Request body must be JSON", code: "invalid_json" }, trace);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(400, { error: "Request body must be an object", code: "invalid_request" }, trace);
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "requestType" && key !== "params")) {
      return json(
        400,
        { error: "Only requestType and params are accepted", code: "invalid_request" },
        trace,
      );
    }
    if (typeof record.requestType !== "string" || !isRequestType(record.requestType)) {
      return json(400, { error: "Unknown requestType", code: "invalid_request" }, trace);
    }
    if (
      record.params !== undefined &&
      (typeof record.params !== "object" || record.params === null || Array.isArray(record.params))
    ) {
      return json(400, { error: "params must be an object", code: "invalid_request" }, trace);
    }
    const now = deps.now ?? Date.now;
    const decision = await routeQuery(
      parsed.upstreams,
      {
        requestType: record.requestType,
        params: record.params as Record<string, unknown> | undefined,
        traceId: trace,
        deadline: now() + budget(env),
      },
      deps,
    );
    console.log(
      JSON.stringify({
        component: "nostr-read-gateway",
        trace,
        requestType: record.requestType,
        attempts: decision.attempts.map((attempt) => ({
          upstream: attempt.upstream,
          kind: attempt.kind,
          latencyMs: attempt.latencyMs,
        })),
      }),
    );
    if (!decision.ok)
      return json(decision.status, { error: decision.error, code: decision.code }, trace);
    return json(200, decision.messages, trace, {
      "x-upstream": decision.upstream.name,
      "x-upstream-type": decision.upstream.type,
      "x-fallback-count": String(decision.fallbackCount),
      "x-response-time": `${decision.latencyMs}ms`,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return json(413, { error: "Request body is too large", code: "body_too_large" }, trace);
    }
    return json(500, { error: "internal error", code: "internal_error" }, trace);
  }
}

export default {
  fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleFetch(request, env);
  },
};
