// packages/test-kit/src/sql-raw.d.ts — virtual module declarations.
//
// `*.sql?raw` is a vite resolver convention that returns the file
// contents as a string. TypeScript's module resolver does not know
// about the `?raw` suffix, so declare it once here.
//
// `cloudflare:test` is a virtual module provided by
// @cloudflare/vitest-pool-workers inside workerd. It only resolves at
// runtime in the worker pool — node-pool callers see a resolution
// failure. We declare a typed shape so dynamic imports typecheck.
//
// D-CAP-004-D: the @cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts
// official surface exists in 0.21.x (verified at node_modules) but the
// test-kit tsconfig does not pull it in. The local declaration below is
// therefore the *only* source of typings, not a shadow. If a future
// tsconfig change starts loading the official module, this file will
// shadow the typed `env` — switch to `declare module 'cloudflare:test'
// { interface DBEnv { DB: D1Database } const env: { DB: D1Database } & ... }`
// or merge at that point. For now the narrow shape is sufficient.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare module 'cloudflare:test' {
  export const env: { DB: D1Database };
  export interface D1Migration {
    name: string;
    queries: string[];
  }
  export function applyD1Migrations(
    db: D1Database,
    migrations: D1Migration[],
    migrationsTableName?: string,
  ): Promise<void>;
  export function reset(): Promise<void>;
}
