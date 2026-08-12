# Phase 6 — Scale & Performance

## Business goal

The system handles realistic load without degradation.

## User value

Snappy UX under load.

## Scope

- **Caching**: KV cache for `installation_state`, `system_settings`, permission lookups (TTL 60s).
- **Pagination**: cursor-based pagination on every list endpoint; stable across inserts.
- **Async dispatch**: outbound jobs dispatched via Cloudflare Queue; backpressure tuning.
- **Performance budgets**:
  - `/inbox` GET p95 ≤ 300 ms.
  - `/messages/send` POST p95 ≤ 800 ms (excluding provider roundtrip).
  - Inbound handler p95 ≤ 5 s for 5 MB messages.
- **Observability**: OpenTelemetry traces; per-module metrics; SLO dashboards.
- **Capacity testing**: k6 load tests at 10× expected peak.
- **R2 lifecycle rules**: archive deleted attachments after 90 days.
- **D1 Time Travel bookmarks** before every production migration.
- **Auto-scaling**: Workers scale automatically; verify cold-start budget.

## Out of scope

Moving to a different runtime.

## Acceptance criteria

```text
[x] p95 /inbox < 300 ms over 10-minute sustained load.
[x] Inbound handler < 5 s p95 for 5 MB messages.
[x] Cold-start budget < 50 ms.
[x] Cache hit rate > 90% for settings.
```

## Key technical decisions

- Cache invalidation: write-through for settings; TTL-based for permissions.
- R2 lifecycle: archive to "cold" storage class after 90 days.
- OpenTelemetry: traces emitted via Workers Analytics Engine.

## Migration from legacy

- All deployments should be on the new system by this phase.
- Legacy system is archived.

## Risks

- Cache stampede on hot keys.
- D1 read amplification on large tenants.