# Security

Report vulnerabilities privately through GitHub security advisories for this repository.

## Boundaries

- Upstream URLs come from `UPSTREAMS`. The request body cannot supply one.
- Credentialed URLs, metadata hosts, link-local addresses, and non-public addresses are rejected. Loopback is available only when `ENVIRONMENT` is `development` or `test`.
- Redirects from an HTTP upstream are not followed.
- Bodies are limited to 256 KiB.
- The gateway budget caps how long a fallback chain can run.
- If `READ_GATEWAY_TOKEN` is set, `Authorization: Bearer` must match. `REQUIRE_AUTH=true` without a token returns 503.
- `GET /health/deep` uses `HEALTH_PROBE_TOKEN`, compared as a SHA-256 digest. Production fails closed when it is unset. The route does not use the query token. Its limit and cache live in the isolate.
- Logs include the request id, request type, upstream name, outcome, and latency. They do not include the token or the request params.
- Browser CORS is `*`. That exposes a read API to web pages. It does not let those pages choose the upstream.

An empty HTTP 200 is a real empty answer from a provider. It is not a cache hit and it is not proof that every other provider agrees.

The Worker does not authenticate to upstreams in this version. Do not point it at an upstream that requires a secret unless you add that header in a later change and keep the secret out of Git.
