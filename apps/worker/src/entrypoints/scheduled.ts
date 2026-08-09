// M1 cut (issue #20): cron-driven maintenance is out of scope for the
// M1 verification gates. The handler is kept as a no-op default export
// so issue #28 (scheduled send) and M2's maintenance backlog can revive
// it without re-wiring the worker export. The `queue` and `email`
// no-ops are defensive: if a future milestone re-routes the worker
// through this module, the entry surface stays stable.
//
// `wrangler.jsonc` still declares the cron triggers (`* * * * *`,
// `0 * * * *`, `17 3 * * *`); with no `scheduled` handler in the worker
// export, Cloudflare just doesn't fire them. The behavioural note in
// issue #20 confirms this is safe — the deferred modules' table writes
// are still preserved by `0010_mvp_minimum.sql` and friends.
import type { Env } from "../platform/config";

export default {
  async email(): Promise<void> {
    // No-op in M1.
  },
  async queue(): Promise<void> {
    // No-op in M1.
  },
  async scheduled(): Promise<void> {
    // No-op in M1.
  },
} satisfies ExportedHandler<Env>;