// Shared helpers for provisioning SchemaForge on TrueForge v0.2.1.
// API shapes confirmed against the @truefoundry/trueforge@0.2.1 and
// @truefoundry/trueforge-core@0.2.1 package sources (see README.md).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const AGENT_NAME = 'schemaforge';
export const CORE_CONNECTOR = 'schemaforge-core';
export const EXECUTOR_CONNECTOR = 'schemaforge-executor';

export const CORE_TOOLS = [
  'db_inspect_schema',
  'db_run_readonly_query',
  'analyze_dependencies',
  'rehearse_migration',
  'verify_production',
];
export const EXECUTOR_TOOLS = ['execute_migration'];

// TrueForge resource names: 2–64 chars, lowercase, hyphens only in between.
const NAME_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function readOptions() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      sandbox: { type: 'boolean', default: false },
      'trueforge-url': { type: 'string' },
      model: { type: 'string' },
      'core-url': { type: 'string' },
      'executor-url': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  const env = process.env;
  return {
    dryRun: values['dry-run'],
    help: values.help,
    sandbox: values.sandbox || env.SF_TRUEFORGE_SANDBOX === 'true',
    trueforgeUrl: (values['trueforge-url'] ?? env.TRUEFORGE_URL ?? 'http://localhost:8790').replace(/\/+$/, ''),
    // Optional: only needed when TrueForge runs with auth (non-standalone).
    trueforgeApiKey: env.TRUEFORGE_API_KEY,
    model: values.model ?? env.SF_TRUEFORGE_MODEL ?? 'openai/gpt-5.2',
    coreUrl: values['core-url'] ?? env.SF_CORE_MCP_URL ?? 'http://127.0.0.1:3100/mcp',
    executorUrl: values['executor-url'] ?? env.SF_EXECUTOR_MCP_URL ?? 'http://127.0.0.1:3101/mcp',
    // Optional bearer keys for SchemaForge's own /mcp endpoints (SF_MCP_API_KEY).
    coreMcpKey: env.SF_CORE_MCP_API_KEY ?? env.SF_MCP_API_KEY,
    executorMcpKey: env.SF_EXECUTOR_MCP_API_KEY ?? env.SF_MCP_API_KEY,
  };
}

function connectorManifest(name, url, description, apiKey) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid TrueForge name: ${name}`);
  const manifest = { type: 'remote', name, url, description };
  if (apiKey) {
    manifest.auth = { type: 'header', headers: { Authorization: `Bearer ${apiKey}` } };
  }
  return manifest;
}

export function buildConnectors(opts) {
  return [
    connectorManifest(
      CORE_CONNECTOR,
      opts.coreUrl,
      'SchemaForge core: read-only production inspection and shadow-database rehearsal. Holds no production write credential.',
      opts.coreMcpKey,
    ),
    connectorManifest(
      EXECUTOR_CONNECTOR,
      opts.executorUrl,
      'SchemaForge executor: applies one human-approved, signed migration to production. Gated by TrueForge approval.',
      opts.executorMcpKey,
    ),
  ];
}

export async function buildAgentManifest(opts) {
  const instructions = await readFile(path.join(REPO_ROOT, 'trueforge-config', 'system-prompt.md'), 'utf8');
  return {
    model: {
      name: opts.model,
      params: { temperature: 0.1, max_tokens: 8192, parallel_tool_calls: false },
    },
    instructions,
    mcp_servers: [
      {
        name: CORE_CONNECTOR,
        enable_tools: CORE_TOOLS,
        preload_tools: ['db_inspect_schema', 'rehearse_migration'],
        // Core is read-only / shadow-only; no human pause needed.
        require_approval_for_tools: [],
        preload: false,
      },
      {
        name: EXECUTOR_CONNECTOR,
        enable_tools: EXECUTOR_TOOLS,
        // Named literally: TrueForge's default "@destructive" only matches tools
        // that publish destructiveHint: true. Both are listed so either rule pauses.
        require_approval_for_tools: ['@destructive', 'execute_migration'],
        preload: true,
      },
    ],
    config: {
      iteration_limit: 80,
      // Daytona is TrueForge's only sandbox provider; enabling this without a
      // configured provider makes agent creation fail, so it is opt-in.
      sandbox: { enabled: opts.sandbox, file_downloads: true },
      dynamic_sub_agents: { enabled: false },
      ask_user_questions: { enabled: true },
    },
  };
}

export const AGENT_DESCRIPTION =
  'Evidence-driven PostgreSQL migration agent: inspects production read-only, rehearses on a shadow database, and applies only human-approved migrations.';

export function createClient(opts) {
  async function call(method, route, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.trueforgeApiKey) headers.authorization = `Bearer ${opts.trueforgeApiKey}`;
    let response;
    try {
      response = await fetch(`${opts.trueforgeUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(
        `Cannot reach TrueForge at ${opts.trueforgeUrl} (${error.cause?.code ?? error.message}). ` +
          'Start it with: npx @truefoundry/trueforge@0.2.1',
      );
    }
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: response.status, ok: response.ok, json };
  }
  return { call };
}

export function errorMessage(result) {
  return result.json?.error?.message ?? result.json?.raw ?? JSON.stringify(result.json);
}

/** Redact header auth values before printing. */
export function redact(value) {
  return JSON.parse(
    JSON.stringify(value, (key, v) => (key === 'Authorization' && typeof v === 'string' ? 'Bearer ***' : v)),
  );
}
