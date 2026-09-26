# Build Story: SchemaForge

> We are not trying to make the AI brave enough to change production. We are trying to make it evidence-driven enough to know when it should, and when it absolutely should not.

## The job we handed over

Schema migrations are routine and risky. A migration changes stateful production data, often while holding locks, and many changes can't be cleanly undone. A careful engineer does the same checks every time: read the live schema, look for rows that would violate the new constraint, trace dependent objects, rehearse on realistic data, plan a rollback, and confirm nothing changed since they last looked. That work is slow and repetitive, and it's easy to skip under deadline pressure.

AI coding tools can already write the SQL. Writing SQL was never the hard part. The hard part is proving the SQL is safe against the real database. SchemaForge gives that proving work to an agent, and keeps the final production write with a human.

## Version 1: the right shape, weak enforcement

The first design (the v2 engineering playbook and `SchemaForge_Build_Plan.md`) set the core sequence: intent, inspect, plan, rehearse, verify, decide, gate, execute, verify. The TypeScript MCP server had six tools, with PostgreSQL 16 production and shadow containers, a read-only `sf_reader` role, and seed data with deliberate edge cases such as 14 NULL emails.

It type-checked. It still didn't deliver what it claimed.

## What the review exposed

Before building further, we reviewed the code against the playbook and recorded 16 findings in an internal implementation plan. Four of them blocked the demo:

- **F1, config mismatch.** The server read `SF_*` environment variables, but the example env file and agent config used different names. No database pool would ever connect.
- **F2, transactions that didn't hold together.** Every `db.query()` checked out a fresh pooled connection. `BEGIN`, the migration and `COMMIT` ran in different sessions, so `ROLLBACK` did nothing and a failed migration could be half-applied.
- **F3, demo data that was never loaded.** Production was created with `email NOT NULL` and zero rows. The 14 NULL emails lived in seed files that Docker Compose never mounted, so the "refuse to apply" scenario could not happen.
- **F5/F6, approvals the agent could forge.** Tokens were plain JSON supplied by the caller, including their own `used` flag. The drift check was described in a comment but never implemented.

Most prototypes have a list like this. We wrote it down and built against it, instead of demoing past it.

## The pivots

**Connection-scoped transactions.** Every multi-statement unit of work now runs on one database session (`mcp-server/src/db.ts`). Rehearsal always ends in an outer `ROLLBACK`, even on success. If rollback can't be confirmed, the connection is destroyed rather than returned to the pool.

**Signed, action-bound approvals.** A human-side CLI (`mcp-server/src/cli/approve.ts`) mints an HMAC-SHA256 token. The token covers:

- the SQL hash and the assertion-set hash
- the baseline and expected post-migration schema fingerprints
- the rehearsal ID, target, nonce and expiry

The executor verifies the token with constant-time comparison. It claims the nonce in a production ledger, so a replayed token is rejected. It aborts if the schema drifted, and rolls back if the post-fingerprint doesn't match what was rehearsed.

**A real process split.** Core (inspection and rehearsal) and executor (production writes) are separate processes with separate credentials. `mcp-server/src/config.ts` refuses to start core if it sees the production write URL or the approval secret. The executor uses a dedicated `sf_executor` role, not the database superuser.

**Assertions, not vibes.** Verification queries must declare an expected result, such as `first_value_true` or `returns_no_rows`. A query that runs without error doesn't count as a pass.

**HTTP for TrueForge.** Midway through, we checked how TrueForge v0.2.1 actually loads agents. It has no agent file format: agents are JSON specs created through the UI or the `POST /api/v1/agents` API. It also cannot launch stdio MCP servers; connectors must be remote HTTP URLs. Our server spoke only stdio, and our `agent.yaml` used a format we had made up. We moved both servers to Streamable HTTP on `127.0.0.1:3100` and `:3101`. We then wrote `scripts/trueforge/provision.mjs`, which registers both connectors and the agent through the real API, and `check.mjs`, which proves the setup. We confirmed the request shapes by reading the TrueForge 0.2.1 package source.

**A bug the tests caught.** While building the end-to-end suite, the tester found a way around the SQL policy. PostgreSQL treats `a$q$` as a single identifier, but the sanitizer read `$q$` as the start of a dollar-quoted string. That meant an `ALTER TABLE ... ADD COLUMN a$q$ int; DROP TABLE orders CASCADE; ...` could hide a `DROP TABLE` inside what the policy thought was a string. The fix landed the same afternoon, and those tests now guard against it.

## What was hard

- **Being honest about sandboxing.** Our sandbox is a rollback-only shadow PostgreSQL. It holds real data and no production credentials. A security review (`docs/review/security-review.md`) found that the shadow role is still a Postgres superuser, and that built-in functions inside DDL expressions could leave side effects the rollback can't undo. That finding (SF-SEC-01) is open, and we name it rather than hide it. TrueForge's own code sandbox runs on Daytona only. It is optional in our setup and off by default.
- **Two approval layers without confusion.** TrueForge's Allow/Deny card has no expiry, single-use limit or fingerprint check. We kept our signed token as a second layer inside the executor, and we explain to judges why both exist.
- **Infrastructure flakiness.** Docker stopped responding on the build machine partway through. The model gateway dropped several agent runs. We wrote files incrementally and recorded exactly what ran and what didn't.

## Where it stands

| Area | Status |
|---|---|
| Role-separated core and executor over Streamable HTTP | Built |
| Signed exact-action tokens, nonce ledger, drift and postcondition checks | Built |
| SQL policy (fail-closed allowlist) | Built; open Low/Medium findings in the security review |
| Unit and HTTP surface tests | 39 passing (32 unit, 7 over real MCP HTTP) |
| Database-backed scenario tests | Written (25), not yet run: Docker was unavailable |
| TrueForge provisioning scripts | Built; dry-run verified; not yet run against a live TrueForge with a model key |
| CI (type-check, build, gitleaks, e2e, LaTeX) | Written; not yet run on GitHub |
| Non-superuser shadow role, isolated network | Planned (SF-SEC-01 fix) |

## Timeline (26 September 2026, IST)

| Time | Event | Source |
|---|---|---|
| 11:10 | Build plan and playbook uploaded | commit `bafef9e` (Harsha N) |
| 13:08 | v2 codebase committed | commit `1b24a4d` (lekhan) |
| 13:12 | Merged with upstream history | commit `50b7bb5` |
| 13:27 | PR #1 merged upstream | commit `be7cddb` |
| 13:33–14:17 | Signed approvals, SQL policy, HTTP transport, approval CLI | file timestamps in `mcp-server/src/security/`, `cli/` |
| 14:08 | End-to-end test suite | `e2e/package.json` |
| 14:21 | CI workflow | `.github/workflows/ci.yml` |
| 14:25 | Hardening commit | commit `e63a3f4` |
| 14:34 | Security review written | `docs/review/security-review.md` |
| 14:40 | TrueForge provisioning scripts | `scripts/trueforge/` |

## How we used AI assistants

The hackathon rules require this disclosure.

- **Claude Code** (Anthropic) reviewed the v1 code and wrote the 16-finding implementation plan in LaTeX. It researched TrueForge's real API by reading the published package source. It also wrote the TrueForge provisioning scripts, the CI workflow, the licence and line-ending config, the end-to-end test suite, the security review and these documents.
- **Kiro** implemented the core server changes in `mcp-server/`: signed approvals, the SQL policy, the HTTP transport, role separation, the executor ledger and the approval CLI.

The team reviewed the output and can explain the architecture and code. Where an assistant found a problem, such as the dollar-quote bypass or the superuser shadow role, the finding is recorded with a file and line so anyone can check it.

## What's next

- Fix SF-SEC-01 through SF-SEC-03: a non-superuser rehearsal role on an isolated network, rollback-only read queries with a pinned `search_path`, and an always-required MCP API key.
- Run the 25 database-backed tests in CI on every PR.
- Integrate with existing migration tools such as Flyway and Liquibase as the evidence layer, not a replacement: a PR adds a migration, and SchemaForge answers READY FOR REVIEW or DO NOT APPLY with evidence attached.
