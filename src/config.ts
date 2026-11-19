import type { Upstream, UpstreamType } from "./types";
import { validateUpstreamUrl } from "./urls";

const TYPES = new Set<UpstreamType>(["primal_ws", "nostrmash_ws", "nostrmash_http"]);

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseUpstreams(
  raw: string | undefined,
  allowLocal: boolean,
): { ok: true; upstreams: Upstream[] } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === "")
    return { ok: false, reason: "upstreams_not_configured" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "upstreams JSON is invalid" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
    return { ok: false, reason: "upstreams must be an array of 1 to 8 providers" };
  }
  const upstreams: Upstream[] = [];
  const names = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "each upstream must be an object" };
    }
    const record = entry as Record<string, unknown>;
    const name = record.name;
    const type = record.type;
    const url = record.url;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
      return { ok: false, reason: "upstream name is invalid" };
    }
    if (names.has(name)) return { ok: false, reason: "upstream names must be unique" };
    names.add(name);
    if (typeof type !== "string" || !TYPES.has(type as UpstreamType)) {
      return { ok: false, reason: "upstream type is invalid" };
    }
    if (typeof url !== "string") return { ok: false, reason: "upstream URL is invalid" };
    const checked = validateUpstreamUrl(url, type as UpstreamType, allowLocal);
    if (!checked.ok) return { ok: false, reason: `${name}: ${checked.reason}` };
    upstreams.push({
      name,
      type: type as UpstreamType,
      url: checked.url,
      priority: clamp(record.priority, 100, 0, 1000),
      connectTimeoutMs: clamp(record.connectTimeoutMs, 3_000, 50, 10_000),
      responseTimeoutMs: clamp(record.responseTimeoutMs, 5_000, 50, 15_000),
      httpTimeoutMs: clamp(record.httpTimeoutMs, 2_000, 50, 10_000),
    });
  }
  return { ok: true, upstreams };
}

export function allowLocalUpstreams(environment: string | undefined): boolean {
  const name = environment?.trim().toLowerCase() ?? "";
  return name === "development" || name === "test";
}
