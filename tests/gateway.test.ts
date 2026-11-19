import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { REQUEST_TYPE_COUNT } from "../src/request-types";
import { handleFetch } from "../src/index";
import type { GatewayEnv } from "../src/types";
import { FakeSocket, frames } from "./fake-socket";

const EVENT_ID = "ab".repeat(32);
const servers: WebSocketServer[] = [];

afterEach(async () => {
  FakeSocket.reset();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function env(upstreams: unknown[], extra: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    ENVIRONMENT: "test",
    UPSTREAMS: JSON.stringify(upstreams),
    ...extra,
  };
}

function post(body: unknown, headers?: HeadersInit): Request {
  return new Request("https://gateway.example/query", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("configuration", () => {
  it("lists 89 request types and does not require NostrMash", () => {
    expect(REQUEST_TYPE_COUNT).toBe(89);
  });

  it("fails closed when no upstreams are configured", async () => {
    const response = await handleFetch(post({ requestType: "net_stats" }), {
      ENVIRONMENT: "production",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("upstreams_not_configured");
  });

  it("rejects metadata, credentials, and client-supplied provider URLs", async () => {
    const metadata = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        { name: "bad", type: "nostrmash_http", url: "https://169.254.169.254/latest", priority: 1 },
      ]),
    );
    expect(metadata.status).toBe(503);
    const secret = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        { name: "bad", type: "primal_ws", url: "wss://user:pass@cache.example/v1", priority: 1 },
      ]),
    );
    expect(secret.status).toBe(503);
    const injected = await handleFetch(
      post({ requestType: "net_stats", url: "https://169.254.169.254/" }),
      env([{ name: "primary", type: "primal_ws", url: "wss://cache.example/v1", priority: 1 }]),
    );
    expect(injected.status).toBe(400);
  });

  it("uses priority rather than array order", async () => {
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1 }], ["EOSE"]]),
    );
    const response = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        { name: "later", type: "primal_ws", url: "wss://later.example/v1", priority: 2 },
        { name: "first", type: "primal_ws", url: "wss://first.example/v1", priority: 1 },
      ]),
      { webSocket: FakeSocket },
    );
    expect(response.headers.get("x-upstream")).toBe("first");
    expect(FakeSocket.created[0]?.url).toBe("wss://first.example/v1");
  });
});

describe("fallback", () => {
  it("answers from a Primal upstream without calling NostrMash", async () => {
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1, content: "hi" }], ["EOSE"]]),
    );
    let fetched = false;
    const response = await handleFetch(
      post({ requestType: "events", params: { event_ids: [EVENT_ID] } }),
      env([{ name: "primal", type: "primal_ws", url: "wss://cache.example/v1", priority: 1 }]),
      {
        webSocket: FakeSocket,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("nostrmash was called");
        },
      },
    );
    expect(response.status).toBe(200);
    expect(fetched).toBe(false);
    expect(response.headers.get("x-fallback-count")).toBe("0");
    const body = (await response.json()) as unknown[][];
    expect(body.at(-1)?.[0]).toBe("EOSE");
    expect(body[0]?.[0]).toBe("EVENT");
    expect(body[0]?.[1]).toBe(body.at(-1)?.[1]);
  });

  it("does not fall through an authoritative empty result", async () => {
    FakeSocket.queue.push((socket) => frames(socket, [["EOSE"]]));
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1 }], ["EOSE"]]),
    );
    const response = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        { name: "primary", type: "primal_ws", url: "wss://primary.example/v1", priority: 1 },
        { name: "secondary", type: "primal_ws", url: "wss://secondary.example/v1", priority: 2 },
      ]),
      { webSocket: FakeSocket },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("primary");
    expect(response.headers.get("x-fallback-count")).toBe("0");
    expect(FakeSocket.created).toHaveLength(1);
  });

  it("falls back when the primary socket fails, times out, or is malformed", async () => {
    FakeSocket.queue.push((socket) => socket.emit("error", new Event("error")));
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1 }], ["EOSE"]]),
    );
    const failed = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        {
          name: "primary",
          type: "primal_ws",
          url: "wss://primary.example/v1",
          priority: 1,
          responseTimeoutMs: 40,
        },
        { name: "secondary", type: "primal_ws", url: "wss://secondary.example/v1", priority: 2 },
      ]),
      { webSocket: FakeSocket },
    );
    expect(failed.headers.get("x-upstream")).toBe("secondary");
    expect(failed.headers.get("x-fallback-count")).toBe("1");

    FakeSocket.reset();
    FakeSocket.queue.push((socket) => {
      socket.open();
    });
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1 }], ["EOSE"]]),
    );
    const timed = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        {
          name: "primary",
          type: "primal_ws",
          url: "wss://primary.example/v1",
          priority: 1,
          connectTimeoutMs: 30,
          responseTimeoutMs: 40,
        },
        { name: "secondary", type: "primal_ws", url: "wss://secondary.example/v1", priority: 2 },
      ]),
      { webSocket: FakeSocket },
    );
    expect(timed.headers.get("x-upstream")).toBe("secondary");

    FakeSocket.reset();
    FakeSocket.queue.push((socket) => {
      socket.open();
      socket.message("not-json");
    });
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1 }], ["EOSE"]]),
    );
    const malformed = await handleFetch(
      post({ requestType: "net_stats" }),
      env([
        { name: "primary", type: "primal_ws", url: "wss://primary.example/v1", priority: 1 },
        { name: "secondary", type: "primal_ws", url: "wss://secondary.example/v1", priority: 2 },
      ]),
      { webSocket: FakeSocket },
    );
    expect(malformed.headers.get("x-upstream")).toBe("secondary");
  });

  it("falls back on an incomplete thread and keeps a complete one", async () => {
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: "cd".repeat(32), kind: 1 }], ["EOSE"]]),
    );
    FakeSocket.queue.push((socket) =>
      frames(socket, [["EVENT", { id: EVENT_ID, kind: 1 }], ["EOSE"]]),
    );
    const response = await handleFetch(
      post({ requestType: "thread_view", params: { event_id: EVENT_ID } }),
      env([
        { name: "primary", type: "primal_ws", url: "wss://primary.example/v1", priority: 1 },
        { name: "secondary", type: "primal_ws", url: "wss://secondary.example/v1", priority: 2 },
      ]),
      { webSocket: FakeSocket },
    );
    expect(response.headers.get("x-upstream")).toBe("secondary");
    expect(response.headers.get("x-fallback-count")).toBe("1");
  });

  it("returns 501 when the only upstream cannot serve the request", async () => {
    let fetched = false;
    const response = await handleFetch(
      post({ requestType: "feed", params: {} }),
      env([{ name: "index", type: "nostrmash_http", url: "https://index.example", priority: 1 }]),
      {
        fetchImpl: async () => {
          fetched = true;
          return new Response("no");
        },
      },
    );
    expect(response.status).toBe(501);
    expect(fetched).toBe(false);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("no_provider_supports_request");
  });
});

describe("nostrmash http", () => {
  it("translates a profile summary and can fall back after an upstream error", async () => {
    const pubkey = "11".repeat(32);
    const response = await handleFetch(
      post({ requestType: "user_profile", params: { pubkey } }),
      env([{ name: "index", type: "nostrmash_http", url: "https://index.example", priority: 1 }]),
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              profile: { name: "Ada" },
              metadata_event_id: EVENT_ID,
              metadata_created_at: 10,
              stats: { follower_count: 3, following_count: 1, note_count: 4 },
            }),
            { status: 200 },
          ),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-type")).toBe("nostrmash_http");
    const body = (await response.json()) as unknown[][];
    expect(body[0]?.[0]).toBe("EVENT");
    expect(body.at(-1)?.[0]).toBe("EOSE");

    FakeSocket.queue.push((socket) => frames(socket, [["EOSE"]]));
    const fallback = await handleFetch(
      post({ requestType: "user_profile", params: { pubkey } }),
      env([
        { name: "index", type: "nostrmash_http", url: "https://index.example", priority: 1 },
        { name: "primal", type: "primal_ws", url: "wss://cache.example/v1", priority: 2 },
      ]),
      {
        webSocket: FakeSocket,
        fetchImpl: async () => new Response("no", { status: 500 }),
      },
    );
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("x-upstream")).toBe("primal");
    expect(fallback.headers.get("x-fallback-count")).toBe("1");
  });

  it("treats a native 404 as an empty result and does not call the next upstream", async () => {
    FakeSocket.queue.push(() => {
      throw new Error("second upstream should not open");
    });
    const response = await handleFetch(
      post({ requestType: "user_profile", params: { pubkey: "22".repeat(32) } }),
      env([
        { name: "index", type: "nostrmash_http", url: "https://index.example", priority: 1 },
        { name: "primal", type: "primal_ws", url: "wss://cache.example/v1", priority: 2 },
      ]),
      {
        webSocket: FakeSocket,
        fetchImpl: async () => new Response("missing", { status: 404 }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("index");
    const body = (await response.json()) as unknown[][];
    expect(body).toHaveLength(1);
    expect(body[0]?.[0]).toBe("EOSE");
  });
});

describe("http surface", () => {
  it("enforces auth, body size, and CORS", async () => {
    const configured = env(
      [{ name: "primal", type: "primal_ws", url: "wss://cache.example/v1", priority: 1 }],
      {
        REQUIRE_AUTH: "true",
      },
    );
    expect((await handleFetch(post({ requestType: "net_stats" }), configured)).status).toBe(503);
    const locked = env(
      [{ name: "primal", type: "primal_ws", url: "wss://cache.example/v1", priority: 1 }],
      {
        READ_GATEWAY_TOKEN: "reader-token",
      },
    );
    expect((await handleFetch(post({ requestType: "net_stats" }), locked)).status).toBe(401);
    FakeSocket.queue.push((socket) => frames(socket, [["EOSE"]]));
    const allowed = await handleFetch(
      post({ requestType: "net_stats" }, { authorization: "Bearer reader-token" }),
      locked,
      { webSocket: FakeSocket },
    );
    expect(allowed.status).toBe(200);
    const oversized = await handleFetch(
      new Request("https://gateway.example/query", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "300000" },
        body: "{}",
      }),
      env([{ name: "primal", type: "primal_ws", url: "wss://cache.example/v1", priority: 1 }]),
    );
    expect(oversized.status).toBe(413);
    const preflight = await handleFetch(
      new Request("https://gateway.example/query", { method: "OPTIONS" }),
      env([]),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("simulated provider socket", () => {
  it("reads EVENT and EOSE from a disposable WebSocket server", async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    servers.push(server);
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as [string, string, { cache: string[] }];
        expect(parsed[2].cache[0]).toBe("server_name");
        socket.send(
          JSON.stringify(["EVENT", parsed[1], { kind: 1, id: EVENT_ID, content: "name" }]),
        );
        socket.send(JSON.stringify(["EOSE", parsed[1]]));
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    const response = await handleFetch(
      post({ requestType: "server_name" }),
      env(
        [{ name: "local", type: "primal_ws", url: `ws://127.0.0.1:${address.port}`, priority: 1 }],
        {
          ENVIRONMENT: "test",
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[][];
    expect(body[0]?.[0]).toBe("EVENT");
    expect(body[1]?.[0]).toBe("EOSE");
  });
});
