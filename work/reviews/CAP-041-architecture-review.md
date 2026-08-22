# CAP-041 - Architecture Review (re-review)

**Status:** ACCEPT-WITH-FOLLOWUPS

## BLOCKER

None. The 2 BLOCKERS and 7 HIGH findings from the prior review are resolved by the fix slice.

- **B1** - `apps/web/src/app/router.tsx:109` `useApiClient()` inside `beforeLoad`: gone. `apps/web/src/app/router.tsx:136-168` reads `apiClient` via the plain `({ context })` argument at line 137. `grep -n "useApiClient\|context.apiClient"` returns zero `useApiClient()` calls inside `beforeLoad`; only `context.apiClient` appears at line 137.
- **B2** - `apps/web/src/infrastructure/api/client-provider.tsx:29-34` `createApiClient(...)` invoked inside the React render without `useMemo`: gone. `apps/web/src/App.tsx:77-84` constructs `apiClient` via `useMemo(() => createApiClient({...}), [])`. The same instance is passed to both `<ApiClientProvider client={apiClient}>` (line 90) and `createAppRouter(apiClient)` (line 85). `client-provider.tsx` no longer calls `createApiClient`; it only consumes the `client` prop and forwards it on `ApiClientContext`.

## HIGH

None. Verified per-finding:

- **H1** - `beforeLoad` must call `fetchSetupStatus(apiClient)` from `setup-queries.ts`: `apps/web/src/app/router.tsx:140` reads `state = await fetchSetupStatus(apiClient);`. Single source of truth.
- **H2** - `setupRoute.path: '/setup/$subStep'` with typed `params.subStep`, no `location.pathname` parsing: `apps/web/src/app/router.tsx:127-132` defines the typed route with `parseParams` and `stringifyParams`. `grep` returns no `location.pathname` hits.
- **H3** - Dead `force(n => n + 1)` cache subscription: `grep` returns no hits. The layout reads status via `setupStatusQuery()` directly; TanStack Query replaces the manual subscription.
- **H5** - `setupMutation` factory deleted: `apps/web/src/features/setup/setup-queries.ts` is 84 lines containing only `setupQueryKeys`, `fetchSetupStatus`, `setupStatusQuery`, `fetchSetupPreflight`, `setupPreflightQuery`. The factory is gone.
- **H7** - `QueryClient.defaultOptions.queries.retry: false`: `apps/web/src/App.tsx:62` sets `retry: false` on queries; line 65 sets `mutations.retry: false`.
- **AC #19** - 8 new `*.test.tsx` files with happy + error path: all 8 step tests exist, each following the `ClaimStep.test.tsx` pattern.
- **AC #6** - `PreflightStep` gates Continue on `data.schemaVersion === CURRENT_SCHEMA_VERSION` from `@unimailbox/contracts`: `packages/contracts/src/index.ts:547` exports `CURRENT_SCHEMA_VERSION = '0013' as const`; `PreflightStep.tsx:15-17` imports it; line 61 computes `const schemaOk = data.schemaVersion === CURRENT_SCHEMA_VERSION`; line 107 disables Continue when `!schemaOk`.

## MEDIUM

### M1 - Unknown subStep fallback

`apps/web/src/app/router.tsx:160-163`. The `subIndex === -1` branch returns without redirecting. Failure scenario: an operator with a stale bookmark hits `/setup/<unknown-segment>`; `setupRoute.beforeLoad` lets the request through, no child route matches, TanStack Router renders the parent component with an empty `<Outlet>`. Fix: change line 162 from `return;` to `throw redirect({ to: '/setup/${activeStep}' as const });`.

### M2 - Duplicate status fetch on cold mount

`setup-layout.tsx:53` + `router.tsx:140`. `setupRoute.beforeLoad` calls `fetchSetupStatus(apiClient)` directly (no cache layer), then `SetupLayout`'s `setupStatusQuery()` fires the same fetch. Every cold navigation produces two HTTP GETs to `/api/v1/setup/status`. Fix: inside `beforeLoad`, write via `queryClient.setQueryData(setupQueryKeys.status(), state)` so the layout's `useQuery` reads from cache.

### M3 - R-WORKFLOW-001 has no end-to-end test coverage

`apps/web/src/test-utils.tsx:195-251` defines `mountAppRouter` for router-level tests, but no test file uses it. Fix: add one router-level test that mounts `setupRoute` with a server reporting `currentStep: 'preflight'`, navigates to `/setup/brevo`, and asserts a redirect to `/setup/preflight`.

## LOW

L1 - `STEP_PATHS` cast at `router.tsx:116-117` is structural and acceptable.
L2 - `subStep as InstallationStep` cast at `router.tsx:158` is safe via `indexOf` returning -1.
L3 - Dead `setupIndexRoute.component` at `router.tsx:174-181` returns `<Outlet />` even though `beforeLoad` always redirects.
L4 - "Duplicate `RouterContext` at lines 62 and 69": false positive. Only one declaration exists at line 62.
L5 - Route ordering `/setup` vs `/setup/$subStep`: TanStack Router v1.135.2 handles this correctly via static-segment precedence.
L6 - `apiClient` token getter closure: `useSetupSession` is a module-level Zustand store; the getter reads `getState()` at call time.
L7 - Router/apiClient race: `useMemo` and `useState` both fire once; same apiClient instance throughout.
L8 - `setupStatusQuery()` at `/setup/claim`: `/api/v1/setup/status` is a public endpoint, returns `currentStep: 'claim'`.
L9 - Worker-side contract: shapes match between `installationStateInfoSchema` (worker) and the wizard's parser.
L10 - Step components read via `useApiClient()`: all 8 step components use React context, not router context.
L11 - Architectural boundaries respected. No `apps/worker` imports; no duplicate contract types; no `localStorage`/`sessionStorage`/`IndexedDB`.
L12 - No deliberate non-goals introduced.

**Recommendation:** ACCEPT-WITH-FOLLOWUPS. The 3 MEDIUMs are reasonable follow-ups but not blocking; they can land as CAP-041.1 or fold into the next capability that touches the wizard. No re-review required for the current diff.
