# Judge Q&A

These are short, honest answers based on the code in this repo. Where something isn't built yet, the answer says so.

**1. Why use an agent instead of Flyway or Liquibase?**
SchemaForge doesn't replace them. Those tools run migrations you already trust. SchemaForge produces the evidence that makes a migration trustworthy. It inspects the current target, rehearses the change against representative data, checks explicit assertions, and returns APPLY, REVIEW or DO_NOT_APPLY. In a real team it would sit in front of the existing migration tool.

**2. What stops the agent from running `DROP TABLE` in production?**
Several layers, and each one works on its own:
- The core process has no production write credential. `config.ts` refuses to start core if one is present.
- The only production-writing tool is `execute_migration` in a separate executor process.
- That tool requires an HMAC token that the agent can't mint.
- The SQL policy (`security/sql_policy.ts`) is a fail-closed allowlist that rejects DROP, TRUNCATE, GRANT, DML and multi-statement smuggling.
- The executor's database role, `sf_executor`, is not a superuser.

**3. Can one approval be reused, or applied to different SQL?**
No. The token is bound to the SHA-256 of the exact SQL and the assertion set, the baseline and expected schema fingerprints, the rehearsal ID, the target and an expiry. Its nonce is claimed atomically in a production ledger, so a second use returns `REPLAY_DETECTED`. The e2e unit tests cover forged signatures, edited SQL, swapped assertions, expired tokens and future-dated tokens.

**4. What if the database changes between rehearsal and apply?**
Inside the apply transaction, the executor compares the live schema fingerprint with the one in the token. A mismatch aborts before any DDL runs. After applying, it checks the post-migration fingerprint against the rehearsed one and rolls back if they differ. The security review notes one gap, SF-SEC-06: under REPEATABLE READ, concurrent DDL by a different admin could slip past the snapshot. Exploiting it requires non-SchemaForge admin credentials.

**5. Is this really sandboxed?**
Generated SQL runs first in a separate shadow PostgreSQL holding representative data. It runs in a single transaction that is always rolled back, and it holds no production credentials. That's our database sandbox. One weakness is open, SF-SEC-01: the shadow role is currently a superuser, so some built-in functions inside DDL can leave side effects the rollback doesn't undo. The planned fix is a non-superuser rehearsal role on an isolated network. TrueForge's own code sandbox, which runs on Daytona, is optional and off by default.

**6. What makes TrueForge necessary, rather than decorative?**
TrueForge runs the agent loop and calls our tools over MCP. It also pauses at its own Allow/Deny approval before `execute_migration`, configured with `require_approval_for_tools`. `scripts/trueforge/provision.mjs` creates the agent and connectors through TrueForge's API, and `check.mjs` verifies that the approval rule is in place.

**7. Why have two approval gates?**
They guard different things. TrueForge's Allow/Deny card confirms that a human saw this tool call. It has no expiry, no single-use rule and no schema binding. Our signed token proves the human approved this exact SQL against this exact schema state, once. Both have to pass.

**8. How do you know the numbers you show are real?**
Row counts and violation counts come from queries run against the database during the rehearsal. Estimates, such as `pg_class.reltuples`, are labelled as estimates. The system prompt forbids the model from inventing measurements, and the decision is computed from tool output rather than model opinion.

**9. What if the migration succeeds but the application breaks?**
`analyze_dependencies` reports foreign keys, views, functions, triggers and indexes that touch the target. After applying, the executor checks the approved assertions and the schema fingerprint. We don't yet scan application code for references, and application rollout remains a separate deployment concern.

**10. What's tested, and what isn't?**
39 tests pass: 32 unit tests covering the token, the SQL policy and the configuration rules, plus 7 that start both servers and call them over real MCP HTTP. Another 25 database-backed tests, covering both scenarios, every executor rejection and read-only write tricks, are written but haven't run. Docker was unavailable on the build machine, and those tests run in CI (`.github/workflows/ci.yml`). The provisioning scripts have been verified in dry-run mode and against TrueForge's published API schema, but not yet against a live TrueForge with a model key.
