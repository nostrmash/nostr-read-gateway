import type { GatewayEnv } from "./types";

export type ProbeAuth =
  | { ok: true }
  | { ok: false; status: 401 | 503; code: "unauthorized" | "probe_auth_not_configured" };

export function localProbeRuntime(env: GatewayEnv): boolean {
  const name = env.ENVIRONMENT?.trim().toLowerCase() ?? "";
  return name === "development" || name === "test";
}

/** Compare SHA-256 digests so the token length is not observable. */
export async function tokenHashesEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length === b.length ? 0 : 1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export async function authorizeProbe(request: Request, env: GatewayEnv): Promise<ProbeAuth> {
  const expected = env.HEALTH_PROBE_TOKEN?.trim() ?? "";
  if (expected.length === 0) {
    return localProbeRuntime(env)
      ? { ok: true }
      : { ok: false, status: 503, code: "probe_auth_not_configured" };
  }
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (bearer.length === 0 || !(await tokenHashesEqual(bearer, expected))) {
    return { ok: false, status: 401, code: "unauthorized" };
  }
  return { ok: true };
}
