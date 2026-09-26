# Five-Minute Demo Run Sheet

All commands and prompts come from the repo as it stands. The source is noted for each.

## Before judges arrive (15 minutes ahead)

- [ ] **Databases up with the deterministic seed:** `docker compose up -d`, then `docker compose ps`. Both containers should show healthy. (`README.md` §2)
- [ ] **Confirm the demo data:** production should have 14 NULL emails. Run `docker exec schemaforge-prod psql -U sf_admin -d schemaforge_prod -c "select count(*) from users where email is null"` and expect `14`. (`shadow/seed-edge-cases.sql`)
- [ ] **Build once:** `npm run setup` and `npm run build`. (root `package.json`)
- [ ] **Terminal 1:** `npm run start:core`. `http://127.0.0.1:3100/health` should return ok.
- [ ] **Terminal 2:** `npm run start:executor`. `http://127.0.0.1:3101/health` should return ok.
- [ ] **Terminal 3:** `npx @truefoundry/trueforge@0.2.1`, then open `http://localhost:8790`.
- [ ] **Model key:** in the TrueForge UI, add it under **Settings → Models**. Do this before screen sharing starts.
- [ ] **Provision:** `node scripts/trueforge/provision.mjs --model <your provider/model>`. Then run `node scripts/trueforge/check.mjs` and confirm every line says PASS. (`scripts/trueforge/README.md`)
- [ ] **Clean prior runs:** make sure no `users.phone` column is left from a rehearsal of Path B. If one exists, reset with `docker compose down -v && docker compose up -d`. This discards local demo data only.
- [ ] **Open a fresh TrueForge chat** with the `schemaforge` agent.

### Never on screen

- `.env*` files
- `SF_APPROVAL_SECRET`
- model API keys, and the TrueForge Settings → Models page after a key is entered
- any terminal that has printed a secret

Close those windows before you share your screen.

## Run sheet

| Time | Beat | What you do and say |
|---|---|---|
| 0:00–0:45 | Problem | "Migrations are routine and risky. AI can write the SQL, but nobody should give it production keys. SchemaForge gives the agent all the verification work and none of the authority." Show the architecture diagram in `README.md`: core on :3100 has no write credential, and the executor on :3101 is the only thing that writes. |
| 0:45–2:00 | Request A | Paste the prompt: *"Make `users.email` NOT NULL and UNIQUE. Prove it is safe before applying anything."* (`README.md`, Path A). Point out the tool calls as they appear in the TrueForge chat: `db_inspect_schema`, `analyze_dependencies`, `db_run_readonly_query`. |
| 2:00–3:00 | Refusal | `rehearse_migration` runs in the rollback-only shadow database and finds 14 NULLs and a duplicate group. The decision is **DO_NOT_APPLY**. Say: "No production tool was called. It knew when to stop." |
| 3:00–3:40 | Request B | Paste the prompt: *"Add an optional `phone VARCHAR(32)` column to users. Rehearse it, verify rollback, and prepare a decision packet."* (`README.md`, Path B). Show the decision packet with its SQL hash, baseline and expected fingerprints, rehearsal ID and assertions. |
| 3:40–4:20 | First human gate | In your own terminal, outside the agent, save the SQL to `migration.sql` and the assertions to `assertions.json`. Then run `npm run approve -- --sql-file migration.sql --assertions-file assertions.json --baseline <BASELINE> --expected <POST> --rehearsal-id <ID> --action "Add optional users.phone column" --confirm` (`README.md`). Say: "The agent cannot mint this token. The signing key lives only on my side and in the executor." |
| 4:20–5:00 | Second gate, apply, verify | Paste the token into a **new** message asking to apply the unchanged SQL. TrueForge shows its **Allow/Deny** card, and you click Allow. The executor verifies both hashes, claims the nonce, checks for drift, applies, and checks postconditions. `verify_production` then confirms the column exists. |

If there's time left, send the same token again. It returns `REPLAY_DETECTED`.

## If something breaks live

| Symptom | Fallback |
|---|---|
| The model is slow or rate-limited | Narrate from `docs/JUDGE_QA.md`, and show the pre-recorded backup video. |
| TrueForge can't reach a connector | Rerun `node scripts/trueforge/check.mjs`. It names the failing connector. Check that the servers in terminals 1 and 2 are still running. |
| `Unknown model ... provider not configured` | The model name passed to `provision.mjs` doesn't match a provider in Settings → Models. Fix it and rerun `provision.mjs`, which is safe to repeat. |
| Docker hangs | Restart Docker Desktop before the slot. The demo can't run without the databases. |
| The agent produces different SQL from the README | That's fine. The decision comes from the rehearsal evidence, not from the exact SQL text. Mint the token for the SQL the agent actually produced. |
| Token rejected with `SCHEMA_DRIFT` | Something changed production after the rehearsal. Ask the agent to rehearse again. That's the safety check working. |

## Honesty guardrails for the talk

- Describe the sandbox as a "rollback-only shadow PostgreSQL". Say TrueForge's Daytona sandbox is on only if you passed `--sandbox` and configured Daytona.
- Don't say "tamper-proof". Say "signed, single-use, bound to the exact SQL and schema state".
- Only show numbers that appeared on screen during this run.
