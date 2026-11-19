import type { ProviderResult } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hex64(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.trim())) return null;
  return value.trim();
}

export function eventFrame(subId: string, event: Record<string, unknown>): unknown[] {
  return ["EVENT", subId, event];
}

export function eoseFrame(subId: string): unknown[] {
  return ["EOSE", subId];
}

export function synthesizedEvent(
  kind: number,
  content: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "",
    pubkey: "",
    created_at: 0,
    kind,
    tags: [],
    content: typeof content === "string" ? content : JSON.stringify(content),
    sig: "",
    ...extra,
  };
}

function eventObject(message: unknown): Record<string, unknown> | null {
  if (!Array.isArray(message) || message[0] !== "EVENT") return null;
  return isRecord(message[2]) ? message[2] : null;
}

/**
 * A well-formed EOSE with no events is an authoritative empty result.
 * Events that do not satisfy a request-specific requirement are incomplete,
 * which is allowed to fall through to the next configured upstream.
 */
export function classifyFrames(
  requestType: string,
  params: Record<string, unknown> | undefined,
  messages: unknown[],
): ProviderResult {
  let sawEose = false;
  let events = 0;
  for (const message of messages) {
    if (!Array.isArray(message) || typeof message[0] !== "string") {
      return { kind: "malformed", reason: "frame is not an array" };
    }
    if (message[0] === "NOTICE") {
      const text = message.filter((item): item is string => typeof item === "string").join(" ");
      if (/error/i.test(text)) return { kind: "upstream_error", reason: "upstream notice" };
    }
    if (message[0] === "EVENT") {
      if (!isRecord(message[2]))
        return { kind: "malformed", reason: "event payload is not an object" };
      events += 1;
    }
    if (message[0] === "EOSE") sawEose = true;
  }
  if (!sawEose) return { kind: "malformed", reason: "missing eose" };
  if (events === 0) return { kind: "empty", messages };
  if (requestType === "event_actions" && typeof params?.kind === "number") {
    const matched = messages.some((message) => eventObject(message)?.kind === params.kind);
    if (!matched)
      return { kind: "incomplete", reason: "event_actions did not include the requested kind" };
  }
  if (requestType === "thread_view" && typeof params?.event_id === "string") {
    const wanted = params.event_id.toLowerCase();
    const matched = messages.some((message) => {
      const id = eventObject(message)?.id;
      return typeof id === "string" && id.toLowerCase() === wanted;
    });
    if (!matched) return { kind: "incomplete", reason: "thread did not include the focal event" };
  }
  return { kind: "complete", messages };
}
