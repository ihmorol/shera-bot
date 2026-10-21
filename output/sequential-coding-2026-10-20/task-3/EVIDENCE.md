# Task 3: PostgreSQL 16 Windows validation

## Binary provenance

- PostgreSQL download page: https://www.postgresql.org/download/windows/
- EDB archive page linked by PostgreSQL.org: https://www.enterprisedb.com/download-postgresql-binaries
- EDB entry: PostgreSQL 16.15, Windows x86-64, file ID `1260623`
- Redirect target: https://get.enterprisedb.com/postgresql/postgresql-16.15-5-windows-x64-binaries.zip
- Download size: `373254386` bytes
- Computed SHA-256: `43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281`
- Publisher checksum: none was published on the PostgreSQL.org or EDB archive pages checked. The computed digest matches the independently published Chocolatey `psql16` package digest, but that is not treated as a publisher checksum.
- Archive verification: `unzip -t` reported no errors; entry paths contained no absolute paths, drive prefixes, parent traversal, or backslashes before extraction.
- Executable versions: `postgres (PostgreSQL) 16.15`; `initdb (PostgreSQL) 16.15`.

The archive and extracted binaries remain workspace-local under this directory. No installer, Windows service, global PATH change, or external database was used.

## Portability defect and fix

The first real cluster reached `database system is ready to accept connections` on `127.0.0.1`, but the test process never proceeded to its first database client. On Windows, the PostgreSQL server inherited `pg_ctl`'s captured stdout/stderr pipe handles, so Node's synchronous child call waited for EOF until the server exited.

`apps/control-plane/test/helpers/pg-cluster.ts` now starts `pg_ctl` with ignored stdio. The server already writes its diagnostics to the harness-owned `postgres.log` through `pg_ctl -l`, so no diagnostic channel was lost.

## Verification

- Real migration cluster smoke: 1 file, 5 tests passed in 9.71 seconds.
- PostgreSQL-dependent control-plane and integration selection: 14 files, 76 tests passed in 44.27 seconds, including `tests/integration/runtime-provisioning.test.ts` with 6 tests.
- Full Vitest suite with `SHERA_PG_BIN` scoped to the test process and `--maxWorkers=2`: 84 files, 834 tests passed in 58.07 seconds.
- ESLint for the changed harness: passed.
- Prettier check for the changed harness: passed.
- Remaining disposable `shera-cp-*` cluster directories after the runs: none.

Exit-code files and complete command logs are stored beside this report.
`cluster-smoke.log` records an initial rejected Vitest `--minWorkers` option; the authoritative smoke result is `cluster-smoke-green.log`.
