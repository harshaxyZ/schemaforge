# SchemaForge

**A TrueForge agent that rehearses PostgreSQL migrations, proves what happened, and stops before production.**

Built for the [TrueFoundry × Polaris “Agents That Act” hackathon](https://hackculture.io/hackathons/agents-that-act). SchemaForge turns a natural-language database change into an evidence-backed migration decision: it inspects a real PostgreSQL target, maps dependencies, runs generated SQL inside a rollback-only shadow sandbox, verifies explicit assertions and rollback equivalence, then freezes at a human approval checkpoint.

The full write-up — problem, architecture, stop conditions, TrueForge usage, real-world application and known limitations — is in [`SchemaForge_Summary.pdf`](SchemaForge_Summary.pdf) (two pages).

> SchemaForge is not a free-running SQL generator. The model proposes; tools measure; policy constrains; a human decides.

## Why it fits the challenge

| Hackathon requirement | SchemaForge proof |
|---|---|
| Run on TrueForge | `trueforge-config/agent.yaml` is a checked setup worksheet and `system-prompt.md` is the canonical instruction set; the setup below uses two remote Streamable HTTP MCP connectors. |
| Reach a real system | Read-only and executor PostgreSQL roles connect to a live PostgreSQL 16 target. |
| Run generated code safely | Generated migration SQL runs first in a separate shadow database, inside one serialized transaction that is unconditionally rolled back. TrueForge sandbox mode is also enabled for helper code. |
| Stop before irreversible action | `execute_migration` publishes MCP `destructiveHint: true`; TrueForge gates it, and the executor additionally requires a signed, short-lived token bound to exact SQL and assertions. |
| Protect credentials/data | Local env files, keys, build output, and runtime state are git-ignored. The core process never receives production write credentials or the signing key. |
| Disclose AI tools | See [AI assistance disclosure](#ai-assistance-disclosure). |

## Architecture

```text
Human ── natural-language objective ──► TrueForge agent loop
                                         │
                     ┌───────────────────┴────────────────────┐
                     │                                        │
           schemaforge-core :3100                  schemaforge-executor :3101
           Streamable HTTP MCP                     Streamable HTTP MCP
           • inspect production (RO)               • execute_migration only
           • dependency analysis                   • destructiveHint: true
           • bounded data reads                    • signed exact-action token
           • shadow rehearsal                      • single-use nonce ledger
           • post-apply verification               • pre/post fingerprint checks
                     │                                        │
           ┌─────────┴──────────┐                             │
           ▼                    ▼                             ▼
   PostgreSQL prod :5433  PostgreSQL shadow :5434      sf_executor role
      sf_reader role        sf_shadow owner           (not DB superuser)
```

The credential split is structural, not a prompt promise. `.env.core` cannot contain the write URL or approval secret; `.env.executor` has no shadow URL; `.env.approval` has no database URL. The production executor serializes applies with a PostgreSQL advisory lock, applies statement and lock timeouts, and keeps migration DDL, the approved assertions, and the success-ledger update in one physical connection and transaction.

## Safety properties

1. **Fail-closed, schema-only SQL policy.** Tier-3 operations, procedural escape hatches, DML, internal-ledger access, ambiguous escaped literals, unknown statements, and mixed/non-transactional plans are rejected in code.
2. **Deterministic sandbox.** Forward SQL, assertions, lock observation, fingerprints, and rollback execute on one shadow session; an outer `ROLLBACK` runs even on success.
3. **Assertions, not vibes.** Verification queries declare an expected outcome (`first_value_true`, `scalar_equals`, `returns_rows`, or `returns_no_rows`). Merely returning without error never passes.
4. **Exact-action approval.** HMAC-SHA256 covers SQL hash, assertion-set hash, baseline and expected fingerprints, rehearsal ID, action, target, nonce, issue time, expiry, and single-use intent.
5. **Replay and drift protection.** The nonce is atomically claimed in a production ledger. Execution aborts if production no longer matches the rehearsed baseline.
6. **Postcondition before commit.** If the production post-fingerprint differs from the rehearsed fingerprint, the migration transaction rolls back.
7. **Two human boundaries.** A human mints the exact token after reading the decision packet, then TrueForge independently pauses the destructive MCP call with Allow/Deny.

## Quick start (Windows PowerShell)

### Prerequisites

- Node.js **22.14+** (TrueForge requirement)
- Docker Desktop with Compose v2
- A TrueForge-supported model credential
- A Daytona sandbox credential if you want TrueForge’s helper-code sandbox enabled

### 1. Install and configure

```powershell
git clone https://github.com/harshaxyZ/schemaforge.git
Set-Location schemaforge
npm run setup
npm run build
Copy-Item config/core.env.example .env.core
Copy-Item config/executor.env.example .env.executor
Copy-Item config/approval.env.example .env.approval
```

Generate one signing secret, then replace the placeholder with the same value in `.env.executor` and `.env.approval`:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Never paste that value into TrueForge, chat, source code, or a demo video.

### 2. Start deterministic demo databases

```powershell
docker compose up -d
docker compose ps
```

The canonical seed is mounted into **both** databases: 500 users plus exactly 14 NULL emails, three duplicate emails, boundary foreign keys, precision edges, and a zero-quantity line item. Existing named volumes retain old state; only if you intentionally want to discard local demo data, run `docker compose down -v` first.

### 3. Start role-separated MCP services

Run these in two terminals:

```powershell
npm run start:core
```

```powershell
npm run start:executor
```

Health endpoints:

```text
http://127.0.0.1:3100/health
http://127.0.0.1:3101/health
```

MCP endpoints:

```text
http://127.0.0.1:3100/mcp
http://127.0.0.1:3101/mcp
```

### 4. Configure TrueForge

Run the current pinned hackathon harness and open `http://localhost:8790`:

```powershell
npx @truefoundry/trueforge@0.2.1
```

Following the official [TrueForge quickstart](https://trueforge.dev/quickstart) and [MCP connector guide](https://trueforge.dev/mcp-servers):

1. Add your model under **Settings → Models**.
2. Add remote connector `schemaforge-core` with URL `http://127.0.0.1:3100/mcp`.
3. Add remote connector `schemaforge-executor` with URL `http://127.0.0.1:3101/mcp`.
4. Configure a Daytona provider under **Settings → Sandbox providers**.
5. Create agent **SchemaForge**; paste `trueforge-config/system-prompt.md` into Instructions.
6. Attach both connectors using the tool selection in the `trueforge-config/agent.yaml` setup worksheet.
7. Require approval for `execute_migration` (the tool is already labeled destructive), enable Sandbox, and save.

TrueForge’s documented default gates tools marked destructive; naming `execute_migration` explicitly in the setup worksheet makes the demo invariant obvious.

## Two-minute demo

### Path A — the agent knows when to stop

Ask:

> Make `users.email` NOT NULL and UNIQUE. Prove it is safe before applying anything.

SchemaForge observes 14 NULLs and a three-row duplicate group. A naive constraint migration fails rehearsal or its assertions, yielding `DO_NOT_APPLY`. No production tool call occurs. This is the key “knows when to stop” story.

### Path B — safe action with two approval gates

Ask:

> Add an optional `phone VARCHAR(32)` column to users. Rehearse it, verify rollback, and prepare a decision packet.

A valid rehearsal uses:

```sql
ALTER TABLE users ADD COLUMN phone VARCHAR(32);
```

with rollback:

```sql
ALTER TABLE users DROP COLUMN phone;
```

and an assertion like:

```sql
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'
) AS ok;
```

The corresponding `assertions.json` is explicit and machine-checkable:

```json
[
  {
    "name": "phone column exists",
    "query": "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone') AS ok",
    "expectation": "first_value_true"
  }
]
```

After reviewing the frozen decision packet, save the exact forward SQL to `migration.sql` and the exact rehearsal assertions to `assertions.json`. Mint a five-minute token outside the agent:

```powershell
npm run approve -- --sql-file migration.sql --assertions-file assertions.json --baseline <BASELINE_SHA256> --expected <POST_SHA256> --rehearsal-id <REHEARSAL_ID> --action "Add optional users.phone column" --confirm
```

Paste the resulting token in a **new** TrueForge message while requesting application of the unchanged SQL and unchanged assertion set. TrueForge pauses at the visible Allow/Deny card. After Allow, the executor verifies both hashes, claims the nonce, checks drift, applies atomically, runs the approved assertions before commit, checks the expected post-fingerprint, and records the outcome. Reusing the token returns `REPLAY_DETECTED`.

## MCP tools

| Connector | Tool | Annotation | Purpose |
|---|---|---|---|
| core | `db_inspect_schema` | read-only | Stable catalog fingerprint and schema evidence |
| core | `db_run_readonly_query` | read-only | Bounded SELECT/read-only CTE through `sf_reader` |
| core | `analyze_dependencies` | read-only | Foreign key, view, function/trigger, and index blast radius |
| core | `rehearse_migration` | write, non-destructive | Rollback-only shadow execution with observed evidence |
| core | `verify_production` | read-only | Expected fingerprint plus explicit postcondition assertions |
| executor | `execute_migration` | **destructive** | Signed one-shot apply with exact SQL/assertions and pre-commit postconditions |

## Repository map

```text
config/                    role-specific env templates
docker/                    production/shadow initialization
e2e/                       Vitest security + black-box MCP/PostgreSQL scenarios
.github/workflows/ci.yml    build, secret scan, e2e, and PDF CI
mcp-server/src/
  cli/approve.ts           human-side HMAC token issuer
  security/                SQL policy and token verification
  tools/                   six MCP tool implementations
  config.ts                fail-fast role/credential validation
  db.ts                    connection-scoped transactions
shadow/                    shared deterministic demo seed + reset helpers
trueforge-config/          TrueForge spec reference and agent instructions
verification/              standalone verification prototypes
SchemaForge_Summary.tex    source for the two-page project summary PDF
```

## Validation

```powershell
npm run check
npm run build
npm test
docker compose config --quiet
```

`npm test` always runs the security and MCP-over-HTTP surface checks. PostgreSQL scenarios auto-skip when the databases are unavailable; CI sets `SF_E2E_REQUIRE_DB=1` against fresh PostgreSQL 16 service containers so a missing database is a failure, not a silent pass.

For a fresh isolated database smoke test, use a separate Compose project name so existing demo volumes are untouched:

```powershell
docker compose -p schemaforge-smoke up -d
```

## AI assistance disclosure

This project used **Claude Opus 5** for repository analysis, implementation assistance, safety review, documentation, and validation. The human team owns the product decisions and must be able to explain the architecture and code. No AI-generated secret or credential is committed.

## References

- [Agents That Act — official challenge and rules](https://hackculture.io/hackathons/agents-that-act)
- [TrueForge repository](https://github.com/truefoundry/trueforge)
- [TrueForge agent configuration and tool approval](https://trueforge.dev/create-agent/overview)
- [TrueForge sandbox model](https://trueforge.dev/sandbox)
- [Model Context Protocol tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

External source descriptions above are paraphrased for licensing compliance.

## License

MIT .

