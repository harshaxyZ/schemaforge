/**
 * Black-box checks that need no database: health, MCP tool surface, and boot refusals.
 * Servers are started by support/global-setup.ts on 3200 (core) / 3201 (executor).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { coreEnv, executorEnv, readEnv } from '../../support/env.js';
import { connect } from '../../support/mcp.js';
import { runToExit } from '../../support/process.js';
import { CORE_TOOLS, EXECUTOR_TOOLS } from '../../support/scenario.js';

const env = readEnv();
let core: Client;
let executor: Client;

beforeAll(async () => {
  core = await connect(env.E2E_CORE_PORT, 'surface-core');
  executor = await connect(env.E2E_EXECUTOR_PORT, 'surface-executor');
});

afterAll(async () => {
  await core?.close();
  await executor?.close();
});

describe('Rule: agent tools are reachable over real MCP Streamable HTTP', () => {
  it.each([
    ['core', 'E2E_CORE_PORT'],
    ['executor', 'E2E_EXECUTOR_PORT'],
  ])('%s /health responds ok', async (role, portKey) => {
    const response = await fetch(`http://127.0.0.1:${env[portKey]}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: `schemaforge-${role}` });
  });

  it('core lists exactly the read/rehearse/verify tools and never execute_migration', async () => {
    const { tools } = await core.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(CORE_TOOLS);
    for (const tool of tools) expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it('executor lists only execute_migration and it carries destructiveHint: true', async () => {
    const { tools } = await executor.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(EXECUTOR_TOOLS);
    expect(tools[0].annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });
});

describe('Rule: the model-facing core process never holds write credentials or the signing secret', () => {
  it('core refuses to boot when SF_PROD_WRITE_URL is set', async () => {
    const result = await runToExit('index.ts', ['--role', 'core'], {
      ...coreEnv(env),
      SF_CORE_PORT: '3290',
      SF_PROD_WRITE_URL: env.E2E_PROD_WRITE_URL,
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to start core: forbidden variables are present: SF_PROD_WRITE_URL/);
  });

  it('core refuses to boot when SF_APPROVAL_SECRET is set', async () => {
    const result = await runToExit('index.ts', ['--role', 'core'], {
      ...coreEnv(env),
      SF_CORE_PORT: '3291',
      SF_APPROVAL_SECRET: env.SF_APPROVAL_SECRET,
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to start core: forbidden variables are present: SF_APPROVAL_SECRET/);
  });
});

describe('Rule: a network-exposed MCP endpoint requires an API key', () => {
  it('refuses a non-loopback bind without SF_MCP_API_KEY', async () => {
    const result = await runToExit('index.ts', ['--role', 'core'], {
      ...coreEnv(env),
      SF_CORE_PORT: '3292',
      SF_HTTP_HOST: '0.0.0.0',
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/SF_MCP_API_KEY is required when the MCP server binds beyond localhost/);
  });
});
