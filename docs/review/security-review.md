# SchemaForge Security Review

Reviewer: Security Engineer agent (read-only). Files first read 08:17–08:28 UTC on 2026-09-26. `sql_policy.ts`, `db.ts`, `execute_migration.ts`, `approval.ts`, `index.ts`, `config.ts`, `rehearse_migration.ts`, and `docker/init-prod.sql` were re-read at 08:56–09:01 UTC after Kiro's edits. Line numbers refer to those later versions. Policy results come from running `requireAtomicMigration` and `requireReadonlyQuery` through `npx tsx` in a throwaway `%TEMP%` script, which was deleted afterwards.

Bottom line: I found no path for core credentials or the LLM to write to production. Every such path needs a token signed by a human, and the HMAC, SQL and assertion hash binding, nonce ledger, drift check, and postcondition checks all held under review. The weakest area is the shadow sandbox. Rehearsal runs as a Postgres superuser, and the DDL allowlist checks only statement prefixes, so arbitrary built-in function calls inside expressions are allowed.

## Findings (most severe first)

### SF-SEC-01 (High): Shadow rehearsal runs as a superuser, and allowlisted DDL can cause side effects that survive the rollback
- Evidence:
  - `docker-compose.yml:32-34`: `sf_shadow` is `POSTGRES_USER`, which makes it a superuser.
  - `mcp-server/src/tools/rehearse_migration.ts:141,171`: `forward_sql` runs on that session.
  - `mcp-server/src/security/sql_policy.ts:112-120`: the allowlist matches only statement prefixes. It never inspects expressions in `DEFAULT`, `USING`, `CHECK`, or view bodies.
- Repro: each of these strings was ACCEPTED by `requireAtomicMigration`.
  - `ALTER TABLE users ADD COLUMN x oid DEFAULT lo_export(lo_from_bytea(0, convert_to('pwn','UTF8')), '/tmp/sf_pwn')` writes a file on the shadow host. File writes are not transactional, so the file survives the ROLLBACK.
  - `ALTER TABLE users ADD COLUMN y int DEFAULT (pg_reload_conf())::int` reloads the server config. Chained with a file write to `postgresql.auto.conf` (for example `archive_command`), this becomes OS command execution in the shadow container. That container shares `schemaforge-net` with prod (`docker-compose.yml:40-41`).
  - `ALTER TABLE users ADD COLUMN x text DEFAULT pg_read_file('/etc/passwd')` reads server files. Assertions can return the content (see SF-SEC-02).
  - `... DEFAULT nextval('users_id_seq')` advances sequences permanently, which causes shadow drift between rehearsals.
- Impact: this breaks the "generated code runs in a sandbox" claim. A prompt-injected LLM gets code execution next to prod. Prod write credentials are not in that container.
- Fix (minimal):
  1. In `docker/init-shadow.sql`, create a non-superuser `sf_rehearser` that owns the app tables, with `NOSUPERUSER NOCREATEROLE NOCREATEDB`. Do not grant it `pg_read_server_files`, `pg_write_server_files`, or `pg_execute_server_program`.
  2. Point `SF_SHADOW_URL` at that role.
  3. Put the shadow on its own Docker network, with no route to `schemaforge-prod`.
  4. Optionally deny function calls in DDL expressions except a small allowlist (`now()`, `gen_random_uuid()`, casts).

### SF-SEC-02 (Medium): `requireReadonlyQuery` is a denylist, so dangerous built-ins pass
- Evidence: `sql_policy.ts:183-196` (the `unsafeRead` regex blocks only `pg_sleep(`, `nextval(`, `setval(`, `lo_import`/`lo_export`, `dblink(`, and `SELECT INTO`).
- Repro: both of these were ACCEPTED.
  - `SELECT pg_sleep_for('10 seconds')`
  - `SELECT set_config('search_path','public,pg_catalog',false)`
- Other built-ins also pass the regex: `pg_read_file()`, `pg_ls_dir()`, `lo_from_bytea()`, `pg_terminate_backend()`, and `pg_reload_conf()`.
- Impact:
  - On shadow, assertions run as the superuser, so they can read files, terminate backends, or reload config. Session-level SETs are reverted by the rehearsal ROLLBACK.
  - On prod, `db_run_readonly_query` commits (`readonly_query.ts:30-45` uses `withTransaction`). A session-level `set_config(..., false)` therefore persists on the pooled `prodReadonly` connection. That lets a later caller shift `search_path` so unqualified catalog names in `inspect_schema.ts` (`pg_attribute`, `pg_extension`) resolve to `public.*` objects. `sf_executor` can create those, because `CREATE VIEW` is allowlisted and it has `CREATE` on `public`. The result is a spoofable `verify_production` fingerprint.
  - In the executor, approved assertions run on the writable `prodWrite` transaction (`execute_migration.ts:166-178`). For example, `SELECT lo_from_bytea(0,'x')` would commit a large object that the fingerprint does not cover. This is hash-bound, so a human would have to approve it.
- Fix:
  - Run read-only and assertion queries through `withRollbackTransaction`, and add `SET LOCAL search_path = pg_catalog, public`.
  - Add `set_config`, `pg_read`, `pg_ls_`, `lo_`, `pg_terminate`, `pg_cancel`, `pg_reload`, `pg_sleep`, and `pg_advisory` to the denylist. Better still, reject any function outside a small allowlist.
  - Schema-qualify every catalog reference with `pg_catalog.` in `inspect_schema.ts`.

### SF-SEC-03 (Medium): `/mcp` is unauthenticated whenever no API key is set
- Evidence:
  - `mcp-server/src/index.ts:211-212`: `if (!apiKey) return true;`
  - `config.ts:79-81`: the key is required only for non-loopback binds.
  - `config/core.env.example` sets no key.
- Repro: any local process or user on the host can `POST http://127.0.0.1:3100/mcp` and call `rehearse_migration`, which gives it the SF-SEC-01 primitive.
  - The executor also accepts calls without a key. It still needs a signed token, so replay and forgery remain blocked.
  - DNS rebinding is blocked on loopback, because SDK 1.30.1's `createMcpExpressApp` adds `localhostHostValidation` (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js:34-37`).
  - A non-loopback bind gets no Host validation, because `index.ts:224` passes no `allowedHosts`.
- Fix:
  - Always require `SF_MCP_API_KEY` (at least 32 random bytes) for both roles.
  - Pass `allowedHosts` to `createMcpExpressApp` whenever `SF_HTTP_HOST` is not loopback.
  - Use a separate key per role.

### SF-SEC-04 (Low): Hash and execute see different bytes (normalization gap)
- Evidence:
  - `sql_policy.ts` `normalizeMigrationSql` replaces CRLF with LF and trims.
  - `approval.ts:20-22` hashes the normalized SQL.
  - `execute_migration.ts:156` runs the raw `input.migration_sql`.
- Repro: approve `COMMENT`/`DEFAULT` SQL that contains a multi-line string literal written with LF. Then submit the same SQL with CRLF inside the literal. The hash matches, but the stored literal value differs. The same gap exists for leading and trailing whitespace inside dollar-quoted bodies.
- Fix: execute `normalizeMigrationSql(input.migration_sql)` in both `execute_migration.ts` and `rehearse_migration.ts`.

### SF-SEC-05 (Low): The ledger guard is bypassable with unicode-escaped identifiers
- Evidence: `sql_policy.ts:153-155` matches the literal text `schemaforge_execution_ledger`.
- Repro: ACCEPTED: `CREATE VIEW v AS SELECT * FROM U&"schemaforge_execution_ledge!0072" UESCAPE '!'`.
  - In prod, `sf_executor` has `SELECT` on the ledger (`init-prod.sql:89`), and default privileges give `sf_reader` SELECT on views it creates (`init-prod.sql:93`). The ledger's nonces, actions, and errors then become readable through the core read tool.
  - Ledger writes are not possible this way, because `sf_executor` lacks ownership and the grants are column-scoped (`init-prod.sql:89-90`).
- Fix: reject `U&` identifiers and literals in `sanitizeSql` (treat them as unsupported, the same way backslashes are rejected).

### SF-SEC-06 (Low): Fingerprint snapshot under REPEATABLE READ can miss concurrent out-of-band DDL
- Evidence: `execute_migration.ts:144-199` uses `isolationLevel: 'REPEATABLE READ'`. The advisory lock serializes only SchemaForge executors.
- Repro: if `sf_admin` commits DDL on a target table after the transaction snapshot is taken but before the ALTER runs, the catalog queries read the snapshot. The pre-fingerprint and post-fingerprint may both pass while the ALTER operates on newer catalog state.
- Exploiting this needs non-SchemaForge admin credentials.
- Fix: use READ COMMITTED, and take `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` on the referenced relations before the pre-fingerprint. Alternatively, re-read the fingerprint after locking.

### SF-SEC-07 (Low): Secret quality is checked only by length
- Evidence: `config.ts:19-22` checks `min(32)` characters and "does not contain `replace`". A secret like `aaaaaaaa...` passes.
- Fix: require hex or base64url that decodes to at least 32 bytes, and document `openssl rand -base64 48`.

### SF-SEC-08 (Low): Demo credentials in tracked files, plus a legacy example using the superuser
- Evidence:
  - `docker-compose.yml:11,34` and `docker/init-prod.sql:9,12` contain `sf_admin_pass`, `sf_shadow_pass`, `sf_reader_pass`, and `sf_executor_pass`.
  - `.env.example:11` sets `PROD_DATABASE_URL` to the `sf_admin` superuser, which contradicts the role split.
- These are clearly demo-only, and the ports bind to `127.0.0.1`. `.env` is not tracked (`git ls-files` shows only `.env.example`).
- Fix: read passwords from `${VAR:?}` in compose. Delete or update the root `.env.example` to match `config/*.env.example`.

## Verified safe
- Token forgery: HMAC-SHA256 with a fixed-order `JSON.stringify` canonical payload (`approval.ts:41-57`). Field injection is not possible, because JSON escapes quotes and the key order is fixed. Signature and hashes are compared with `crypto.timingSafeEqual` after a length check (`approval.ts:100,106,111`).
- Token binding: the token is bound to the SQL hash, the assertions hash, target, baseline and expected fingerprints, and the TTL. Expiry is checked against the executor's clock (`approval.ts:120-128`), with 30s skew allowed for `issued_at` and the TTL capped by server config.
- No minting path: no MCP tool can sign. The core role refuses to start with `SF_APPROVAL_SECRET` or `SF_PROD_WRITE_URL` (`config.ts:68`). `db.ts` creates only role-authorized pools. The CLI refuses DB URLs.
- Replay and races: the nonce is claimed with `INSERT ... ON CONFLICT (nonce) DO NOTHING RETURNING`, keyed on the UUID primary key, so only one of two concurrent executes wins. The ledger update also requires `status='started'`. A crash after the claim burns the token, which fails closed.
- Drift check: the drift check, apply, postcondition fingerprint, and assertions all run in one transaction under an advisory lock. Any failure means ROLLBACK.
- Statement splitting: comment and quote splitting is safe, and multi-statement smuggling is caught (`/* ; */ DROP TABLE` was rejected). `DO $$` and `CALL` are rejected. Backslashes and `E''` are rejected outright (`sql_policy.ts:23-28`), and unterminated quotes are rejected. The dollar-tag-in-identifier fix at `sql_policy.ts:70` is correct. `COPY`, `CREATE FUNCTION`, `SET ROLE`, `EXECUTE`, `GRANT`, and `OWNER TO` all fall outside the prefix allowlist or hit explicit rules.
- `sf_reader`: it is granted only SELECT on the four app tables, with no ledger access, no superuser, and no server-file roles. PG16 removes the PUBLIC CREATE grant on `public` by default. Every read runs `SET TRANSACTION READ ONLY` (`db.ts:80`). Identifiers use `escapeIdentifier`, `format('%I')`, or bound parameters. `SF_LEDGER_TABLE` is regex-restricted.
- HTTP: binds to `127.0.0.1` by default. The API-key check is constant-time. The SDK's DNS-rebinding guard is active on loopback. `express.json()` limits bodies to 100 kB by default. No CORS headers are sent, and a JSON content type forces a preflight.
- Rehearsal transaction: always rolled back (`db.ts:110-140`), and the connection is destroyed if rollback cannot be confirmed. Non-transactional statements are rejected. The only persistent shadow effects are the ones in SF-SEC-01.
- Human gate: `trueforge-config/agent.yaml:43-45` gates `execute_migration` by name and through `@destructive`. The system prompt forbids minting tokens and stops at the approval step.
