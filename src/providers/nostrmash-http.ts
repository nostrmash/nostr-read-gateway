import { eoseFrame, eventFrame, hex64, isRecord, synthesizedEvent } from "../frames";
import type { ProviderResult, QueryInput } from "../types";

const SUPPORTED = new Set(["user_profile", "user_infos", "events", "thread_view"]);
const MAX_BYTES = 1_000_000;

interface NativeBody {
  status: number;
  body: unknown;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finish(events: Record<string, unknown>[]): ProviderResult {
  if (events.length === 0) {
    return { kind: "empty", messages: [eoseFrame(subscription())] };
  }
  const subId = subscription();
  return {
    kind: "complete",
    messages: [...events.map((event) => eventFrame(subId, event)), eoseFrame(subId)],
  };
}

function subscription(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `nm${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readJson(
  url: string,
  timeoutMs: number,
  traceId: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<NativeBody | ProviderResult> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "x-request-id": traceId,
        ...init?.headers,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      return { kind: "upstream_error", reason: "redirects are not followed" };
    }
    const text = await response.text();
    if (text.length > MAX_BYTES) return { kind: "malformed", reason: "upstream body is too large" };
    if (response.status === 404) return { status: 404, body: null };
    if (response.status >= 500) return { kind: "upstream_error", reason: "upstream status 5xx" };
    if (response.status !== 200)
      return { kind: "upstream_error", reason: "upstream status was not usable" };
    if (text.trim() === "") return { status: 200, body: null };
    try {
      return { status: 200, body: JSON.parse(text) as unknown };
    } catch {
      return { kind: "malformed", reason: "upstream json is invalid" };
    }
  } catch (error) {
    const name =
      typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
    if (name === "TimeoutError" || name === "AbortError")
      return { kind: "timeout", reason: "http timeout" };
    return { kind: "connection_failed", reason: "http request failed" };
  }
}

function isResult(value: NativeBody | ProviderResult): value is ProviderResult {
  return "kind" in value;
}

function kind0(
  pubkey: string,
  profile: unknown,
  id: unknown,
  createdAt: unknown,
): Record<string, unknown> | null {
  let content: string | null = null;
  if (
    typeof profile === "string" &&
    profile.trim() !== "" &&
    profile.trim() !== "null" &&
    profile.trim() !== "{}"
  ) {
    content = profile;
  } else if (isRecord(profile) && Object.keys(profile).length > 0) {
    content = JSON.stringify(profile);
  }
  if (!content) return null;
  return synthesizedEvent(0, content, {
    id: typeof id === "string" ? id : "",
    pubkey,
    created_at: numberValue(createdAt),
  });
}

export async function queryNostrMashHttp(
  baseUrl: string,
  input: QueryInput,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  if (!SUPPORTED.has(input.requestType)) return { kind: "unsupported" };
  const remaining = Math.max(0, input.deadline - Date.now());
  if (remaining < 50) return { kind: "timeout", reason: "gateway budget exhausted" };
  const timeoutMs = Math.min(2_500, remaining);
  const base = baseUrl.replace(/\/$/, "");
  if (input.requestType === "user_profile") return profile(base, input, timeoutMs, fetchImpl);
  if (input.requestType === "user_infos") return profiles(base, input, timeoutMs, fetchImpl);
  if (input.requestType === "events") return events(base, input, timeoutMs, fetchImpl);
  return thread(base, input, timeoutMs, fetchImpl);
}

async function profile(
  base: string,
  input: QueryInput,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  const pubkey = hex64(input.params?.pubkey);
  if (!pubkey) return { kind: "incomplete", reason: "user_profile requires a 64 character pubkey" };
  const response = await readJson(
    `${base}/api/v1/users/${encodeURIComponent(pubkey)}/summary`,
    timeoutMs,
    input.traceId,
    fetchImpl,
  );
  if (isResult(response)) return response;
  if (response.status === 404 || response.body === null) return finish([]);
  if (!isRecord(response.body))
    return { kind: "malformed", reason: "profile summary was not an object" };
  const stats = isRecord(response.body.stats) ? response.body.stats : null;
  const metadata = kind0(
    pubkey,
    response.body.profile,
    response.body.metadata_event_id,
    response.body.metadata_created_at,
  );
  const rows: Record<string, unknown>[] = [];
  if (metadata) rows.push(metadata);
  if (stats) {
    rows.push(
      synthesizedEvent(
        10000105,
        {
          pubkey,
          follows_count: numberValue(stats.following_count),
          followers_count: numberValue(stats.follower_count),
          note_count: numberValue(stats.note_count),
        },
        { pubkey },
      ),
    );
  }
  return finish(rows);
}

async function profiles(
  base: string,
  input: QueryInput,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  const pubkeys = Array.isArray(input.params?.pubkeys)
    ? input.params.pubkeys
        .map(hex64)
        .filter((item): item is string => item !== null)
        .slice(0, 100)
    : [];
  if (pubkeys.length === 0) return { kind: "incomplete", reason: "user_infos requires pubkeys" };
  const response = await readJson(
    `${base}/api/v1/profiles/batch`,
    timeoutMs,
    input.traceId,
    fetchImpl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkeys }),
    },
  );
  if (isResult(response)) return response;
  if (response.status === 404) return finish([]);
  const rows =
    isRecord(response.body) && Array.isArray(response.body.profiles)
      ? response.body.profiles
      : null;
  if (!rows) return { kind: "malformed", reason: "profile batch was not usable" };
  const eventsOut: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const pubkey = hex64(row.pubkey);
    if (!pubkey) continue;
    const metadata = kind0(pubkey, row.profile, row.metadata_event_id, row.metadata_created_at);
    if (metadata) eventsOut.push(metadata);
  }
  return finish(eventsOut);
}

async function events(
  base: string,
  input: QueryInput,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  const ids = Array.isArray(input.params?.event_ids)
    ? input.params.event_ids
        .map(hex64)
        .filter((item): item is string => item !== null)
        .slice(0, 100)
    : [];
  if (ids.length === 0) return { kind: "incomplete", reason: "events requires event_ids" };
  const response = await readJson(
    `${base}/api/v1/events/batch`,
    timeoutMs,
    input.traceId,
    fetchImpl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    },
  );
  if (isResult(response)) return response;
  if (response.status === 404) return finish([]);
  const rows =
    isRecord(response.body) && Array.isArray(response.body.events) ? response.body.events : null;
  if (!rows) return { kind: "malformed", reason: "event batch was not usable" };
  return finish(rows.filter(isRecord));
}

async function thread(
  base: string,
  input: QueryInput,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  const eventId = hex64(input.params?.event_id);
  if (!eventId) return { kind: "incomplete", reason: "thread_view requires event_id" };
  const [threadRes, countsRes] = await Promise.all([
    readJson(
      `${base}/api/v1/threads/${encodeURIComponent(eventId)}?limit=100`,
      timeoutMs,
      input.traceId,
      fetchImpl,
    ),
    readJson(
      `${base}/api/v1/events/${encodeURIComponent(eventId)}/counts`,
      timeoutMs,
      input.traceId,
      fetchImpl,
    ),
  ]);
  if (isResult(threadRes)) return threadRes;
  if (isResult(countsRes)) return countsRes;
  if (threadRes.status === 404) return finish([]);
  if (!isRecord(threadRes.body) || !isRecord(countsRes.body))
    return { kind: "malformed", reason: "thread payload was not usable" };
  if (numberValue(countsRes.body.zap_count) > 0) {
    return { kind: "incomplete", reason: "native thread does not include zap receipts" };
  }
  const notes = [
    threadRes.body.event,
    ...(Array.isArray(threadRes.body.ancestors) ? threadRes.body.ancestors : []),
    ...(Array.isArray(threadRes.body.replies) ? threadRes.body.replies : []),
  ].filter(isRecord);
  const focal = notes.some(
    (note) => typeof note.id === "string" && note.id.toLowerCase() === eventId.toLowerCase(),
  );
  if (!focal)
    return { kind: "incomplete", reason: "native thread did not include the focal event" };
  return finish(notes);
}
