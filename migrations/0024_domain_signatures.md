# 0024 — Domain signatures

## Purpose

Create the tenancy-owned `domain_signatures` table for CAP-068. A unique
`domain_id` index enforces one signature per managed domain. HTML and text are
stored as scalar columns; the Worker sanitizes HTML before persistence.

## Compatibility window

Forward-compatible. The additive table can be applied before the CAP-068
Worker routes are deployed. No existing table or column is changed.

## Expected duration

Sub-second on an empty or normal D1 database; the migration creates one table
and two indexes and performs no data backfill.

## Data backfill

None. Legacy signature rows require an explicit import decision and are not
silently inferred from the legacy singleton settings table.

## Verification

Run `0024_domain_signatures.verify.sql` after applying the migration. It
checks the tracking row, table/column shape, unique domain index, cascading
foreign key, enabled/content checks, and scalar storage.

## Recovery

Take a D1 Time Travel bookmark before production application. If deployment
must be rolled back, leave the additive table in place and roll back only the
Worker/API code; there is no destructive rollback in this migration.
