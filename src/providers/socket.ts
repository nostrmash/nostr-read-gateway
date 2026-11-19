import { classifyFrames } from "../frames";
import { NO_PARAMS_TYPES } from "../request-types";
import type { GatewaySocket, ProviderResult, QueryInput, Upstream } from "../types";

function textFrame(event: Event): string | null {
  if (!("data" in event)) return null;
  return typeof event.data === "string" ? event.data : null;
}

export async function querySocket(
  upstream: Upstream,
  input: QueryInput,
  Socket: new (url: string) => GatewaySocket,
): Promise<ProviderResult> {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const subId = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const remaining = Math.max(0, input.deadline - Date.now());
  if (remaining < 50) return { kind: "timeout", reason: "gateway budget exhausted" };
  const connectMs = Math.min(upstream.connectTimeoutMs, remaining);
  const responseMs = Math.min(upstream.responseTimeoutMs, remaining);
  const filter = NO_PARAMS_TYPES.has(input.requestType)
    ? ["REQ", subId, { cache: [input.requestType] }]
    : ["REQ", subId, { cache: [input.requestType, input.params ?? {}] }];

  return new Promise((resolve) => {
    let socket: GatewaySocket;
    try {
      socket = new Socket(upstream.url);
    } catch {
      resolve({ kind: "connection_failed", reason: "socket setup failed" });
      return;
    }
    let settled = false;
    let opened = false;
    const frames: unknown[] = [];
    const finish = (result: ProviderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const connectTimer = setTimeout(() => {
      if (!opened) finish({ kind: "timeout", reason: "connect timeout" });
    }, connectMs);
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(connectTimer);
      responseTimer = setTimeout(
        () => finish({ kind: "timeout", reason: "response timeout" }),
        responseMs,
      );
      try {
        socket.send(JSON.stringify(filter));
      } catch {
        finish({ kind: "connection_failed", reason: "socket send failed" });
      }
    });
    socket.addEventListener("message", (event: Event) => {
      const text = textFrame(event);
      if (text === null) {
        finish({ kind: "malformed", reason: "non-text frame" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        finish({ kind: "malformed", reason: "invalid json" });
        return;
      }
      if (!Array.isArray(parsed)) {
        finish({ kind: "malformed", reason: "frame is not an array" });
        return;
      }
      frames.push(parsed);
      if (parsed[0] === "NOTICE") {
        const notice = parsed.filter((item): item is string => typeof item === "string").join(" ");
        if (/error/i.test(notice)) finish({ kind: "upstream_error", reason: "upstream notice" });
        return;
      }
      if (parsed[0] === "EOSE") {
        if (parsed[1] !== subId) {
          finish({ kind: "malformed", reason: "eose subscription did not match" });
          return;
        }
        finish(classifyFrames(input.requestType, input.params, frames));
      }
    });
    socket.addEventListener("error", () =>
      finish({ kind: "connection_failed", reason: "socket error" }),
    );
    socket.addEventListener("close", () => {
      if (!settled) finish({ kind: "connection_failed", reason: "socket closed" });
    });
  });
}
