# TrueForge provisioning

These scripts register SchemaForge on a local TrueForge v0.2.1 and check that it is set up correctly. TrueForge has no agent file format, so agents and connectors are created through its HTTP API. `trueforge-config/agent.yaml` is a human-readable worksheet; these scripts are the source of truth for what gets sent.

## Steps

1. Start both SchemaForge MCP servers. See the root README; by default they listen on `http://127.0.0.1:3100/mcp` (core) and `http://127.0.0.1:3101/mcp` (executor).
2. Start TrueForge and open http://localhost:8790:
   ```bash
   npx @truefoundry/trueforge@0.2.1
   ```
3. In the TrueForge UI, go to **Settings → Models** and add your model provider and API key. The key stays in TrueForge's local store. It never goes in this repo, a script, or the demo video.
4. Optional: to enable TrueForge's code sandbox, add a Daytona provider under **Settings → Sandbox**, then pass `--sandbox` in the next step.
5. Provision:
   ```bash
   node scripts/trueforge/provision.mjs --dry-run   # show exactly what will be sent
   node scripts/trueforge/provision.mjs --model openai/gpt-5.2
   ```
   Running it again updates the connectors and agent in place.
6. Verify:
   ```bash
   node scripts/trueforge/check.mjs
   ```
   Every line should print `PASS`, and the script exits with a non-zero status if any check fails.

## Options

| Flag | Env | Default |
|---|---|---|
| `--trueforge-url` | `TRUEFORGE_URL` | `http://localhost:8790` |
| `--model` | `SF_TRUEFORGE_MODEL` | `openai/gpt-5.2` |
| `--core-url` | `SF_CORE_MCP_URL` | `http://127.0.0.1:3100/mcp` |
| `--executor-url` | `SF_EXECUTOR_MCP_URL` | `http://127.0.0.1:3101/mcp` |
| `--sandbox` | `SF_TRUEFORGE_SANDBOX=true` | off |
| | `SF_MCP_API_KEY`, or `SF_CORE_MCP_API_KEY` / `SF_EXECUTOR_MCP_API_KEY` | none. If set, the key is sent to TrueForge as a connector `Authorization: Bearer` header. |
| | `TRUEFORGE_API_KEY` | only needed when TrueForge runs with auth (not standalone) |

## What gets created

- **Connector `schemaforge-core`** (`type: remote`): the five read-only and shadow tools. It needs no approval.
- **Connector `schemaforge-executor`** (`type: remote`): only `execute_migration`, with `require_approval_for_tools: ["@destructive", "execute_migration"]`. TrueForge pauses with Allow/Deny before every production write. The tool name is listed explicitly because `@destructive` only matches tools that publish `destructiveHint: true`.
- **Agent `schemaforge`**: its instructions are loaded from `trueforge-config/system-prompt.md`, with temperature 0.1, parallel tool calls off, and an iteration limit of 80.

## API reference

Confirmed from the `@truefoundry/trueforge@0.2.1` and `@truefoundry/trueforge-core@0.2.1` package sources:

- `PUT /api/v1/mcp-servers` with `{ manifest: { type: "remote", name, url, description, auth? } }` creates or replaces a connector by name. The schema is strict, and `auth` is `{ type: "header", headers: {...} }` or `{ type: "dcr" }`.
- `GET /api/v1/mcp-servers/{name}` and `GET /api/v1/mcp-servers/{name}/tools`.
- `GET /api/v1/agents?agent_name=...` returns `{ data: [...], pagination }`.
- `POST /api/v1/agents` with `{ name, description, manifest }` returns `201`, or `409` if the name exists.
- `PUT /api/v1/agents/{agent_id}` with `{ description?, manifest }` updates an agent.
- Names must match `^[a-z][a-z0-9-]{0,62}[a-z0-9]$`. `schemaforge` and `tfg` are fine, but the names `tfg` and `trueforge` are reserved.
- Agent creation checks that the model's provider is configured (`Unknown model ... provider not configured`). If `config.sandbox.enabled` is set, it also checks that a sandbox provider exists.
- Standalone mode (the default for `npx`) needs no API credential.

Not yet verified against a running instance: the tool `annotations` field name in the `/tools` response. `check.mjs` accepts both `destructiveHint` and `destructive_hint`.
