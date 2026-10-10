# scripts/

Top-level repository scripts invoked via `pnpm scaffold <subcommand>`. The
dispatcher lives in `scripts/scaffold.ts` and routes each subcommand to its
own script file. CAP-003 ships only `doctor`; later capabilities add
`db:migrate`, `db:verify`, etc.

`pnpm scaffold doctor` runs `scripts/doctor.ts`, which performs 10 structural
checks (binding names, migration shape, module dependency zones, tsconfig
strict, etc.) and exits 0 on a healthy repo or 1 with a clear list of
problems. It is the first gate in `.claude/rules/testing.md` §Quality gates.