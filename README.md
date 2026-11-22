# Nostr Read Gateway

Nostr Read Gateway provides a single HTTP interface for querying compatible Nostr data providers.

It routes requests across configured upstreams, normalizes supported responses, and falls back when a provider is unavailable or cannot satisfy a request.

It is an independent Cloudflare Worker utility maintained by NostrMash. Neither NostrMash Core nor SmartFlowSocial is required.

A configuration that lists only Primal-compatible sockets works. NostrMash is an optional adapter, not a default.

This is not a relay, a distributed cache, or a complete Nostr index. It does not store the events it returns.

## Runtime

Cloudflare Workers. Local development uses Wrangler. This project does not ship a Docker image.

- Node.js 22 or newer
- pnpm 12.21.0

## Install and test

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm exec wrangler dev
```

## Configure upstreams

`UPSTREAMS` is a JSON array. Put it in `.dev.vars` locally. Do not commit that file. An empty value fails closed.

```json
[
  {
    "name": "primary",
    "type": "primal_ws",
    "url": "wss://cache.example/v1",
    "priority": 1
  },
  {
    "name": "index",
    "type": "nostrmash_http",
    "url": "https://index.example",
    "priority": 2
  }
]
```

Lower `priority` is tried first. Names must be unique. At most eight upstreams.

| type             | Transport                                                     | What it can answer                                             |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `primal_ws`      | WebSocket using the Primal cache `REQ` shape                  | The 89 request names in `src/data/primal-request-types.json`   |
| `nostrmash_ws`   | Same socket shape, against a NostrMash compatibility endpoint | The same 89 names, when that endpoint implements them          |
| `nostrmash_http` | `GET` and `POST` under `/api/v1`                              | `user_profile`, `user_infos`, `events`, and `thread_view` only |

Other request types on the HTTP adapter are skipped. They are not reported as empty success. See [docs/UPSTREAMS.md](docs/UPSTREAMS.md).

`http://` and `ws://` are rejected unless `ENVIRONMENT` is `development` or `test`. Metadata, link-local, and credentialed URLs are rejected. Clients cannot choose the upstream URL.

The whole attempt stops at `GATEWAY_BUDGET_MS` (default 20 seconds, maximum 25).

## Call it

```bash
curl -X POST http://127.0.0.1:8787/query \
  -H 'content-type: application/json' \
  -d '{"requestType":"net_stats"}'
```

A successful body is a Primal-style list of `EVENT` frames ending in `EOSE`. Headers name the upstream that answered and how many earlier upstreams failed.

An authoritative empty result is HTTP 200 with only `EOSE`. The gateway does not ask the next upstream after that.

## Health

`GET /health` checks configuration only. It does not open an upstream.

`GET /health/deep` runs one `net_stats` request with a three-second deadline. An authoritative empty result, including a response that contains only `EOSE`, is success. HTTP 503 means every configured upstream failed or the gateway is misconfigured. The probe does not require NostrMash or SmartFlowSocial.

## Deploy

CI does not deploy. The script name is `nostrmash-nostr-read-gateway`. Confirm it is free in your Cloudflare account before the first deploy. Do not reuse `smartflowsocial-primal-cache-worker`.

```bash
pnpm exec wrangler deploy
```

Set `UPSTREAMS` as a var for that environment. If you set `READ_GATEWAY_TOKEN`, clients must send `Authorization: Bearer <token>`. `REQUIRE_AUTH=true` without a token fails closed.

## Security

The public response allows any browser origin. That does not make the Worker an open proxy: provider URLs come from trusted configuration. See [SECURITY.md](SECURITY.md).

## License

[Unlicense](LICENSE). The request-type list and the NostrMash HTTP translation started from the Unlicense `smartflowsocial-cache-worker` repository. See [docs/PROVENANCE.md](docs/PROVENANCE.md).
