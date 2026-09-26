#!/usr/bin/env node
// Idempotently registers SchemaForge's two MCP connectors and the SchemaForge
// agent on a running TrueForge v0.2.1 instance.
//
//   node scripts/trueforge/provision.mjs [--dry-run] [--sandbox]
//        [--trueforge-url URL] [--model provider/model]
//        [--core-url URL] [--executor-url URL]

import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  buildAgentManifest,
  buildConnectors,
  createClient,
  errorMessage,
  readOptions,
  redact,
} from './lib.mjs';

const USAGE = `Usage: node scripts/trueforge/provision.mjs [options]

  --dry-run             Print the JSON requests without sending them
  --sandbox             Enable TrueForge's Daytona sandbox (needs a Daytona provider in Settings)
  --trueforge-url URL   Default: $TRUEFORGE_URL or http://localhost:8790
  --model NAME          Default: $SF_TRUEFORGE_MODEL or openai/gpt-5.2 (provider must be set up in Settings → Models)
  --core-url URL        Default: $SF_CORE_MCP_URL or http://127.0.0.1:3100/mcp
  --executor-url URL    Default: $SF_EXECUTOR_MCP_URL or http://127.0.0.1:3101/mcp

Optional env: TRUEFORGE_API_KEY (non-standalone TrueForge), SF_MCP_API_KEY /
SF_CORE_MCP_API_KEY / SF_EXECUTOR_MCP_API_KEY (bearer keys for SchemaForge /mcp).`;

async function main() {
  const opts = readOptions();
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const connectors = buildConnectors(opts);
  const manifest = await buildAgentManifest(opts);
  const agentRequest = { name: AGENT_NAME, description: AGENT_DESCRIPTION, manifest };

  if (opts.dryRun) {
    for (const c of connectors) {
      console.log(`PUT ${opts.trueforgeUrl}/api/v1/mcp-servers`);
      console.log(JSON.stringify(redact({ manifest: c }), null, 2));
    }
    const shown = { ...agentRequest, manifest: { ...manifest, instructions: `<${manifest.instructions.length} chars from trueforge-config/system-prompt.md>` } };
    console.log(`POST ${opts.trueforgeUrl}/api/v1/agents  (or PUT /api/v1/agents/{agent_id} if it exists)`);
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  const client = createClient(opts);

  // 1. Connectors: PUT /api/v1/mcp-servers is "create or replace" by name.
  for (const c of connectors) {
    const result = await client.call('PUT', '/api/v1/mcp-servers', { manifest: c });
    if (!result.ok) throw new Error(`Connector ${c.name}: HTTP ${result.status}: ${errorMessage(result)}`);
    const status = result.json?.data?.auth_status?.status ?? 'unknown';
    console.log(`✔ connector ${c.name} → ${c.url} (auth: ${status})`);
  }

  // 2. Agent: find by name, then update in place or create.
  const listed = await client.call('GET', `/api/v1/agents?agent_name=${encodeURIComponent(AGENT_NAME)}`);
  if (!listed.ok) throw new Error(`List agents: HTTP ${listed.status}: ${errorMessage(listed)}`);
  const existing = (listed.json?.data ?? []).find((a) => a.name === AGENT_NAME);

  const result = existing
    ? await client.call('PUT', `/api/v1/agents/${encodeURIComponent(existing.id)}`, {
        description: AGENT_DESCRIPTION,
        manifest,
      })
    : await client.call('POST', '/api/v1/agents', agentRequest);

  if (!result.ok) {
    const message = errorMessage(result);
    const hint = /Unknown model/.test(message)
      ? `\n  → Add the model provider in the TrueForge UI (Settings → Models) or pass --model with a configured one.`
      : /sandbox/i.test(message)
        ? `\n  → Configure a Daytona sandbox provider in the TrueForge UI, or rerun without --sandbox.`
        : /MCP server/.test(message)
          ? `\n  → Connector registration failed; check the SchemaForge servers are running.`
          : '';
    throw new Error(`Agent ${AGENT_NAME}: HTTP ${result.status}: ${message}${hint}`);
  }
  console.log(`✔ agent ${AGENT_NAME} ${existing ? 'updated' : 'created'} (id ${result.json?.data?.id})`);
  console.log(`\nOpen ${opts.trueforgeUrl} and start a chat with "${AGENT_NAME}". Verify with: node scripts/trueforge/check.mjs`);
}

main().catch((error) => {
  console.error(`✘ ${error.message}`);
  process.exit(1);
});
