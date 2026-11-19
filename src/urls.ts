import type { UpstreamType } from "./types";

export function validateUpstreamUrl(
  raw: string,
  type: UpstreamType,
  allowLocal: boolean,
): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "upstream URL is invalid" };
  }
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "upstream URL cannot contain credentials" };
  const websocket = type === "primal_ws" || type === "nostrmash_ws";
  const allowed = websocket
    ? allowLocal
      ? ["wss:", "ws:"]
      : ["wss:"]
    : allowLocal
      ? ["https:", "http:"]
      : ["https:"];
  if (!allowed.includes(url.protocol))
    return { ok: false, reason: "upstream URL scheme is not allowed" };
  const host = url.hostname.toLowerCase();
  if (host.length === 0 || /^\d+$/.test(host))
    return { ok: false, reason: "upstream host is not allowed" };
  if (
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "localhost" ||
    host.endsWith(".localhost")
  ) {
    if (!(allowLocal && (host === "localhost" || host === "127.0.0.1" || host === "::1"))) {
      return { ok: false, reason: "upstream host is not allowed" };
    }
  }
  if (host.includes(":")) {
    if ((host === "::1" && !allowLocal) || host.startsWith("fe80:") || host.startsWith("ff")) {
      return { ok: false, reason: "upstream address is not allowed" };
    }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split(".").map((part) => Number(part));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const loopback = a === 127;
    const privateNet = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    const blocked =
      a === 0 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      ((loopback || privateNet) && !allowLocal);
    if (blocked || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return { ok: false, reason: "upstream address is not allowed" };
    }
  }
  if (!websocket && url.protocol === "ws:")
    return { ok: false, reason: "upstream URL scheme is not allowed" };
  return { ok: true, url: url.toString().replace(/\/$/, "") };
}
