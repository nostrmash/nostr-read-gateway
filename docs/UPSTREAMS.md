# Upstreams

Provider selection uses the trusted `UPSTREAMS` configuration. A request body cannot add or replace a provider. Unknown fields on the body are rejected.

## Attempt order

1. Sort by `priority` ascending, then by name.
2. Skip a provider that does not implement the request type. A skip does not increase `X-Fallback-Count`.
3. Use the first provider that returns a complete result or an authoritative empty result.
4. Try the next provider after a connection failure, timeout, malformed payload, explicit upstream error, or incomplete result.
5. Stop when the gateway budget is exhausted.

`X-Fallback-Count` is the number of supported providers that failed before the one that answered.

## Result classes

| Class             | Meaning                                                                                                                                         | Next provider                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| complete          | `EOSE` plus events that satisfy the request                                                                                                     | no                            |
| empty             | `EOSE` and no events. The provider answered and had nothing                                                                                     | no                            |
| unsupported       | This adapter does not implement the request type                                                                                                | yes, not counted as a failure |
| incomplete        | Events arrived, but a required event or kind was missing. A native thread with zap receipts is incomplete because that payload has no kind 9735 | yes                           |
| malformed         | The payload was not a usable frame list or JSON document                                                                                        | yes                           |
| timeout           | Connect, response, or budget timer                                                                                                              | yes                           |
| connection_failed | The socket or HTTP client failed                                                                                                                | yes                           |
| upstream_error    | HTTP status other than 200/404, a redirect, or a `NOTICE` containing "error"                                                                    | yes                           |

HTTP 404 from NostrMash HTTP is an empty result for `user_profile`, `user_infos`, `events`, and `thread_view`. It is not a signal to try another provider.

If every supported provider fails, the status is 504 when all of those failures were timeouts, otherwise 502. If none support the request, the status is 501 `no_provider_supports_request`.

## NostrMash HTTP

The adapter calls:

- `GET /api/v1/users/{pubkey}/summary`
- `POST /api/v1/profiles/batch`
- `POST /api/v1/events/batch`
- `GET /api/v1/threads/{id}` and `GET /api/v1/events/{id}/counts`

Redirects are not followed. Profile and stats frames use Primal's kind 0 and kind 10000105 shapes so an existing Primal client can read them. Kind 10000105 frames are synthesized. They are not signed Nostr events.

A native thread that has `zap_count` greater than zero is incomplete on purpose. A socket upstream can still return the zap receipts.

## Timeouts

Each upstream can set `connectTimeoutMs`, `responseTimeoutMs`, and `httpTimeoutMs`. They are clamped, and they are also clamped to the time left in the gateway budget.

## Request names

`src/data/primal-request-types.json` has 89 names. A `primal_ws` or `nostrmash_ws` upstream is asked for all of them. That does not mean every upstream has data for every name. An empty `EOSE` is still a successful empty answer.
