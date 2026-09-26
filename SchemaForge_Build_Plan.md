# SchemaForge — End-to-End Build Plan
**Agents That Act — TrueFoundry × Polaris, 26 Sep 2026**

One line: **An agent that rehearses a database migration on a real shadow copy before it ever touches production, and can only apply it after a human approves the exact change.**

---

## 1. What judges are actually scoring (build to this, not to features)

| Criterion | Weight | What "goated" looks like here |
|---|---|---|
| Harness is doing the work | 30% | TrueForge visibly owns the loop: MCP dispatch, sandbox invocation, approval freeze, session persistence. Not us calling an LLM and pretending. |
| It actually runs | 25% | Real Postgres, real MCP calls, real Daytona sandbox, real generated SQL, real approval, real apply. Zero mocked numbers anywhere. |
| Where it stops | 20% | One tool (`execute_migration`) is the only irreversible action. Everything upstream runs free. This is your centerpiece. |
| A job worth handing over | 15% | DBA/SRE migration review is real, tedious, high-consequence work. Say this out loud in the demo. |
| Demo clarity | 10% | One linear story, no branching, no "let me also show you." |

Every hour you spend below should trace back to one of these five rows. If it doesn't, cut it.

---

## 2. Corrected architecture (verified against the actual TrueForge repo/docs — not assumptions)

- **MCP servers must be reachable over HTTP/SSE at a URL.** TrueForge does not run local stdio MCP processes. Build your 4 tools as one small HTTP MCP server (`http://localhost:4000/mcp`), register it under **Settings → Connectors → Add MCP Server**.
- **Approval is a harness setting, not something you code inside the tool.** Default gating only fires on tools annotated `destructiveHint: true` (the `@destructive` selector). Do both of these for `execute_migration`:
  - Set `destructiveHint: true` on the tool definition
  - Explicitly set `require_approval_for_tools: ["execute_migration"]` on the agent config — don't trust the default alone
- **Daytona API key needs Sandboxes access AND Snapshots write/create permission.** Missing snapshot-write fails provider setup with no clear error. Check this first.
- **Model: Groq as a custom OpenAI-compatible provider** (Settings → Models → Add custom provider — base URL + key + model ID). Free, fast, zero dependency on organizer credit handouts. If real OpenAI API access lands, swap it in later — it's a one-line config change, not a rebuild.
- **Node.js 22.14+ required.** Check `node -v` before running `npx @truefoundry/trueforge@latest`.
- Agent config: `sandbox.enabled: true`, `iteration_limit: 15` (default 100 is too loose — cap it so a confused run doesn't spiral mid-demo).

```
MODEL (Groq)
   ↓
TRUEFORGE AGENT LOOP  ← this is what you're proving works
   ↓
MCP TOOL SERVER (yours, HTTP)
 ├─ inspect_schema        (read-only)
 ├─ run_readonly_query    (read-only)
 ├─ rehearse_migration    (sandbox / shadow DB, no prod creds)
 └─ execute_migration     (destructiveHint:true + approval-gated)
   ↓
TRUEFORGE APPROVAL FREEZE
   ↓
HUMAN APPROVES EXACT MIGRATION
   ↓
PRODUCTION APPLY → POST-CHECK
```

**Critical credential rule:** the normal agent loop never holds prod write credentials. `execute_migration` is the only tool with write access, and it only runs after approval.

---

## 3. Scope — locked, do not add to this list

- Schema: `users, products, orders, order_items`, seeded with a few thousand rows
- **Bad case:** `ALTER TABLE users ALTER COLUMN email SET NOT NULL` — seed ~14 NULL emails on purpose → rehearsal fails → agent returns **DO NOT APPLY** with evidence
- **Good case:** `ALTER TABLE users ADD COLUMN archived_at TIMESTAMP NULL` — passes rehearsal → human approves → real apply → post-check confirms
- One repo, one Postgres target, one shadow environment. No multi-DB, no CI/CD integration, no auth system.

If you think of a 5th feature mid-build: write it on paper, don't touch the code.

---

## 4. Tool responsibilities

| Tool | Does | Approval? |
|---|---|---|
| `inspect_schema` | Reads columns, types, constraints, indexes, row counts via read-only DB role | No |
| `run_readonly_query` | Allowlisted SELECT-only analysis, statement timeout enforced | No |
| `rehearse_migration` | Runs generated DDL + verification plan against the Daytona-sandboxed shadow copy | No |
| `execute_migration` | Applies the exact approved migration to the real Supabase target | **Yes — gated** |

**Decision packet the agent must output every run (this is your evidence, not an opinion):**
```
Target: public.users
Requested change: email → NOT NULL
Rows inspected: <real count>
Violations found: <real count>
Shadow rehearsal: PASSED / FAILED
Schema drift: NONE / DETECTED
DECISION: APPLY / REVIEW / DO NOT APPLY
Production database: UNTOUCHED (until approved)
```
Label every number as **observed** (measured during rehearsal) or **estimated** — never present an estimate as a measurement. Judges will test exactly this.

**Approval token, bound to one exact action:**
```
approval_token = {
  migration_hash: "sha256:...",
  target: "public.users",
  action: "ALTER COLUMN email SET NOT NULL",
  expires_at: "...",
  single_use: true
}
```
Re-verify the schema fingerprint at execute time — if the target drifted since inspection, invalidate and force a re-rehearsal.

**PostgreSQL correctness — bake these in, they're cheap and they're your depth signal:**
- Classify DDL by transactional semantics before running it (`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block — don't wrap everything in one transaction blindly)
- Never present an unmeasured value as a measurement
- Don't claim universal rollback — irreversible ops (`DROP COLUMN`, destructive rewrites) are flagged or refused, not silently "rolled back"

---

## 5. Build order — 6–8 hour window

| Hr | Do this | Done when |
|---|---|---|
| 1 | `node -v` check → `npx @truefoundry/trueforge@latest` → add Groq (custom provider) → add Daytona (check snapshot permission) | You can chat with a bare agent using Groq |
| 2 | Write `inspect_schema` as an HTTP MCP server, register via Add MCP Server | Agent returns real column/constraint data from your Supabase DB |
| 3 | Seed schema + data + the 14-NULL edge case. Write `rehearse_migration` running against a Daytona-sandboxed shadow copy | Agent can run a migration in the sandbox and report real pass/fail |
| 4 | Write `execute_migration`, mark `destructiveHint:true`, set `require_approval_for_tools` on the agent | Chat UI visibly freezes with Allow/Deny before this tool fires |
| 5 | Run both scripted paths end to end 3+ times: bad case → DO NOT APPLY, good case → approve → real apply → post-check | Both paths are boring and reliable, not "worked once" |
| 6 | Build the decision-packet display (just enough UI to read on a projector) | A judge can read the evidence without you narrating every field |
| 7 | Record a full backup demo video | Video exists even if wifi/laptop dies live |
| 8 (if you have it) | Dry-run the 5-minute pitch out loud, twice | You're not reading the plan while presenting it |

---

## 6. Five-minute demo script

| Time | Beat |
|---|---|
| 0:00–0:45 | Problem: database changes are stateful and hard to reverse — GitHub, Buildkite, and Linear all had real production incidents from unsafe migrations. TrueForge lets an agent do the verification work without blind authority. |
| 0:45–2:00 | Dangerous request: "Make users.email NOT NULL." Agent inspects the live schema. |
| 2:00–3:00 | Shadow rehearsal runs. Finds 14 real NULL emails. Decision: DO NOT APPLY. Production untouched. |
| 3:00–3:40 | Corrected request: add `archived_at`, nullable. |
| 3:40–4:20 | Rehearsal passes. TrueForge freezes before execution. No pre-selected approval. |
| 4:20–5:00 | Human approves the exact migration. Real apply. Post-check confirms the real target changed. |

Say the line out loud near the start or end: **"We're not trying to make the AI brave enough to change production. We're trying to make it evidence-driven enough to know when it should — and when it absolutely should not."**

---

## 7. Judge Q&A — the tough ones, prepared

**Q: Why can't TrueForge alone do this? Why do you need an agent?**
TrueForge is the harness — the execution loop, MCP dispatch, sandbox invocation, session state, approval freeze. On its own it has zero opinion about databases; it doesn't know what a safe migration looks like. The agent is the domain layer we built on top: the system prompt, the four tools, the Postgres-specific risk logic. TrueForge is necessary infrastructure, not sufficient — without our agent config it's an empty shell. That separation (generic runtime + domain-specific agent) is exactly what "Agents That Act" is testing.

**Q: Why AI instead of Flyway/Liquibase?**
We don't replace the migration engine — we add an adaptive inspection, rehearsal, and decision layer around a *requested* change. Static tools execute known, pre-written migrations. They don't reason from live current state about a novel change and produce a risk judgment. Ours does.

**Q: Why should I trust the sandbox result — isn't it just an empty DB?**
No — the shadow copy is seeded with representative data and deliberately planted edge cases (the 14 NULL emails). We distinguish "the SQL compiles" from "the SQL is safe against real data," and only claim the second when we've actually measured it.

**Q: What if the agent hallucinates the migration SQL?**
It never reaches production on a hallucination — the rehearsal step catches syntax and constraint failures against real shadow data before the decision packet is even generated, and `execute_migration` is approval-gated regardless of what the agent claims.

**Q: What prevents the agent from running DROP TABLE or something destructive?**
Layered: `destructiveHint` annotation, explicit `require_approval_for_tools` gating, a read-only DB role for all inspection tools, and no unrestricted write credential anywhere in the normal agent loop. The write path is a single, separate, gated tool.

**Q: Can one approval authorize multiple migrations, or a changed migration?**
No — the token is bound to a migration hash, exact target, and is single-use with an expiry. If the schema drifts after inspection, the token is invalid and a fresh rehearsal is required.

**Q: What if rollback is impossible?**
We don't claim universal reversibility. Reversible changes get a generated, rehearsed rollback. Irreversible/destructive operations are flagged or refused outright, never silently promised as recoverable.

**Q: Is this really a production database?**
It's a controlled Postgres environment representing the target system. What's real and unmocked: the database engine, the MCP calls, the sandbox execution, the migration execution, the verification. Nothing here is a mocked API response.

**Q: How is this different from Copilot suggesting a SQL snippet?**
Copilot suggests text you still have to trust and run yourself. This system inspects the live target, executes the change against realistic data before anyone commits to it, produces measured evidence, and only a human-approved, hash-bound action ever reaches the real database.

---

## 8. Non-negotiable cuts

No multi-database support. No CI/CD integration. No auth system. No generic multi-agent swarm. If a feature doesn't move one of the five rubric rows in Section 1, it doesn't get built today.
