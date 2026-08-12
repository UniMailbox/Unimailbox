# ADR-001 — Modular Monolith on Cloudflare Workers

## Status

Accepted.

## Context

The legacy system is a single Worker with no module boundaries: 21 `api-*.js` files call 28 `service-*.js` files that all import each other freely. Adding new capabilities has steadily increased coupling.

The alternatives were:

1. **Stay monolithic but restructure**: one Worker, multiple modules with clear boundaries.
2. **Decompose into microservices**: separate Workers (or external services) for each bounded context.
3. **Move to a different runtime**: e.g., Node.js, Bun, or a long-running server.

## Decision

We adopt a **modular monolith**: one Worker, multiple modules with clear boundaries, no cross-module imports of internal implementations.

## Consequences

### Positive

- Single deployment, single set of bindings, single monitoring surface.
- Module boundaries enforced by TypeScript imports + code review.
- Lower latency than multi-service (no inter-service hops).
- Cheaper to operate (one Worker, one D1, one R2 bucket).

### Negative

- All modules share the same Worker CPU/IO budget; a slow use case in one module affects others.
- Cannot scale modules independently.
- A bug in one module can affect others.

### Mitigations

- Per-request timeout budget tracked.
- Use cases are explicit; long-running work goes to the queue consumer.
- Structured logging + request IDs for traceability.

## Alternatives considered

- **Microservices**: rejected. Adds deployment complexity for a system whose scale does not require it. Premature optimization.
- **Move to Node.js**: rejected. Cloudflare Workers is the deployment target; Node.js would lose D1, R2, KV, Queue, Email Routing integration.
- **Polyrepo**: rejected. The Worker + web client + shared contracts benefit from a monorepo.