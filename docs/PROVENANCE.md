# Provenance

The gateway router, upstream configuration, and fallback rules were written for this repository.

The 89 Primal request names in `src/data/primal-request-types.json` are the public vocabulary used by Primal-compatible caches. The file was carried over from `smartflowsocial/smartflowsocial-cache-worker`, which is published under the Unlicense.

`src/providers/nostrmash-http.ts` is a new module with the same idea as that Worker's native reader: turn a few NostrMash `/api/v1` JSON responses into Primal `EVENT` / `EOSE` frames, and refuse to pretend a zapped thread is complete. It is not a claim that every NostrMash response can be represented that way. The field names `follows_count` and kind `10000105` are the Primal client's expected shape.

NostrMash Core is not imported. Its HTTP paths are an optional adapter.

No code from `getAlby/http-nostr-publisher` is included.

This repository does not inherit the old Worker Git history.
