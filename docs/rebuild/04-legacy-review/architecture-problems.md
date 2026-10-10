# Architecture Problems (Reference)

The full catalog is in `../D-major-architectural-problems.md`. This document is a categorized summary for quick reference during refactor work.

## Top 10 by impact

| # | Problem | Severity | Action | Phase |
|---|---|---|---|---|
| 1 | Single-round SHA-256 password hashing | Critical | REDESIGN | 0 |
| 2 | SQL injection in `public-service.addUser` | Critical | REMOVE | 0 |
| 3 | Plaintext secrets in `setting` table | Critical | REDESIGN | 0 |
| 4 | `email-service.send` is 3 services in one (311 lines) | High | REDESIGN | 2 |
| 5 | `setting` is a 57-column god-object | High | REDESIGN | 0 |
| 6 | JSON-in-text columns everywhere | High | REDESIGN | 0 |
| 7 | Two sources of authorization truth (routes + perm_key) | High | REMOVE | 0 |
| 8 | Prefix-matched permission routes | High | REDESIGN | 0 |
| 9 | Provider SDKs imported directly in `email-service` | High | REDESIGN | 2 |
| 10 | `att-service.toImageUrlHtml` 170 lines | Medium | REDESIGN | 3 |

## Counts by action

| Action | Count |
|---|---:|
| REMOVE | 14 |
| REDESIGN | 19 |
| SIMPLIFY | 2 |
| MERGE | 0 (folded into REDESIGN) |
| SPLIT | 0 (folded into REDESIGN) |
| KEEP | 0 |
| ADD | 6 |
| DEFER | 3 |
| **Total problems identified** | **41** |

## Counts by category

| Category | Count |
|---|---:|
| Security-critical | 8 |
| Domain leakage | 6 |
| Schema & data | 5 |
| Historical / accidental | 10 |
| Wrong boundaries | 5 |
| Premature/missing abstractions | 9 |
| **Total** | **41** |

## Phase distribution

| Phase | Problems addressed |
|---|---:|
| 0 | 23 |
| 1 | 2 |
| 2 | 7 |
| 3 | 2 |
| 4 | 1 |
| 5 | 4 |
| 6 | 0 |
| REMOVED (no phase) | 2 |
| **Total** | **41** |

Phase 0 absorbs the most problems because it is the foundation. After Phase 0 ships, the codebase has **18 problems remaining** — and they are all about reshaping internals, not about safety or correctness.