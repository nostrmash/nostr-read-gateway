# Changelog

## Unreleased

- `GET /health/deep` probes one configured upstream with `net_stats`. `GET /health` remains a configuration check.

## 0.1.0

First implementation. Ordered upstreams, Primal-compatible socket reads, an optional NostrMash HTTP adapter, and fallback that keeps authoritative empty results.
