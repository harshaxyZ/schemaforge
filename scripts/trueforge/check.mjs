#!/usr/bin/env node
// Verifies SchemaForge is correctly provisioned on TrueForge and prints
// PASS/FAIL per check. Exits non-zero if any check fails.
//
//   node scripts/trueforge/check.mjs [--trueforge-url URL]

import {
  AGENT_NAME,
  CORE_CONNECTOR,
  CORE_TOOLS,
  EXECUTOR_CONNECTOR,
  EXECUTOR_TOOLS,
  createClient,
  errorMessage,
  readOptions,
} from './lib.mjs';

const results = [];
const record = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const opts = readOptions();
  const client = createClient(opts);

  // Connectors registered, and their tools are discoverable by TrueForge.
  for (const [name, expectedTools] of [
    [CORE_CONNECTOR, CORE_TOOLS],
    [EXECUTOR_CONNECTOR, EXECUTOR_TOOLS],
  ]) {
    const got = await client.call('GET', `/api/v1/mcp-servers/${name}`);
    record(got.ok, `connector ${name} registered`, got.ok ? got.json.data.manifest.url : errorMessage(got));
    if (!got.ok) continue;

    const tools = await client.call('GET', `/api/v1/mcp-servers/${name}/tools`);
    if (!tools.ok) {
      record(false, `connector ${name} reachable`, `HTTP ${tools.status}: ${errorMessage(tools)} (is the SchemaForge server running?)`);
      continue;
    }
    const list = tools.json?.data ?? [];
    const names = list.map((t) => t.name);
    const missing = expectedTools.filter((t) => !names.includes(t));
    record(missing.length === 0, `connector ${name} exposes expected tools`, missing.length ? `missing ${missing.join(', ')}` : names.join(', '));

    if (name === EXECUTOR_CONNECTOR) {
      const exec = list.find((t) => t.name === 'execute_migration');
      const hint = exec?.annotations?.destructiveHint ?? exec?.annotations?.destructive_hint;
      record(hint === true, 'execute_migration advertises destructiveHint: true', `got ${JSON.stringify(hint)}`);
    }
    if (name === CORE_CONNECTOR) {
      record(!names.includes('execute_migration'), 'core connector cannot execute production migrations');
    }
  }

  // Agent exists with the approval gate on execute_migration.
  const listed = await client.call('GET', `/api/v1/agents?agent_name=${encodeURIComponent(AGENT_NAME)}`);
  const agent = listed.ok ? (listed.json?.data ?? []).find((a) => a.name === AGENT_NAME) : undefined;
  record(Boolean(agent), `agent ${AGENT_NAME} exists`, agent ? `id ${agent.id}, model ${agent.manifest.model.name}` : listed.ok ? 'not found' : errorMessage(listed));

  if (agent) {
    const servers = agent.manifest.mcp_servers ?? [];
    const executor = servers.find((s) => s.name === EXECUTOR_CONNECTOR);
    const approval = executor?.require_approval_for_tools ?? [];
    record(approval.includes('execute_migration'), 'TrueForge requires human approval for execute_migration', JSON.stringify(approval));
    const core = servers.find((s) => s.name === CORE_CONNECTOR);
    record(Boolean(core), 'agent attaches the core connector');
    const coreExposesExec = (core?.enable_tools ?? []).some((t) => t === 'execute_migration' || t === '@all');
    record(!coreExposesExec, 'core attachment does not expose execute_migration');
    console.log(`INFO  sandbox enabled: ${agent.manifest.config?.sandbox?.enabled === true}`);
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
});
