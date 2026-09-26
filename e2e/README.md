# SchemaForge e2e

A black-box test suite. It uses a real MCP client over Streamable HTTP against core and executor processes that it spawns from `../mcp-server/src` with `tsx`, on ports 3200 and 3201. Nothing is written into `mcp-server/`.

## Run

```sh
cd e2e
npm ci
docker compose -f ../docker-compose.yml up -d   # prod :5433, shadow :5434
npm test            # unit + e2e
npm run test:unit   # in-process security primitives, no DB
npm run test:e2e    # health, tool surface, boot refusals, scenarios A/B, rejections
npm run typecheck
```

Every run, `support/global-setup.ts` writes `.env.e2e.local`, which is git-ignored, with a fresh random `SF_APPROVAL_SECRET`. To override connection URLs or ports, create `.env.e2e.local` using the `E2E_*` keys documented in `support/env.ts`. If the databases are unreachable, DB-backed scenarios are skipped. Set `SF_E2E_REQUIRE_DB=1` to make that a failure instead.

## Side effects on production

Scenario B really adds `users.archived_at`. It then removes it through the same human-gated executor path, with a CLI-minted token for `DROP COLUMN`. The drift test creates and drops `e2e_drift_probe_idx` through the admin URL. If a run is interrupted, `beforeAll` and `afterAll` remove both leftovers through the admin URL. Successful and rejected attempts leave rows in `schemaforge_execution_ledger`, which is by design.
