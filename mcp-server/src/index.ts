#!/usr/bin/env node
/** Role-separated Streamable HTTP MCP entry point for TrueForge. */

import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { db } from './db.js';
import { loadConfig, portForRole, type ProcessRole } from './config.js';
import { inspectSchema } from './tools/inspect_schema.js';
import { runReadonlyQuery } from './tools/readonly_query.js';
import { analyzeDependencies } from './tools/analyze_dependencies.js';
import { rehearseMigration } from './tools/rehearse_migration.js';
import { verifyProduction } from './tools/verify_production.js';
import { executeMigration } from './tools/execute_migration.js';

const VERSION = '2.1.0';

const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const assertionBase = {
  name: z.string().min(1).max(120),
  query: z.string().min(1),
};
const assertionSchema = z.discriminatedUnion('expectation', [
  z.object({ ...assertionBase, expectation: z.literal('returns_rows') }),
  z.object({ ...assertionBase, expectation: z.literal('returns_no_rows') }),
  z.object({ ...assertionBase, expectation: z.literal('first_value_true') }),
  z.object({
    ...assertionBase,
    expectation: z.literal('scalar_equals'),
    expected_value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
]);

const approvalSchema = z.object({
  payload: z.object({
    version: z.literal(1),
    nonce: z.string().uuid(),
    migration_hash: z.string().regex(/^[a-f0-9]{64}$/i),
    assertions_hash: z.string().regex(/^[a-f0-9]{64}$/i),
    baseline_fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
    expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
    rehearsal_id: z.string().min(1),
    target: z.literal('prod'),
    action: z.string().min(1).max(500),
    issued_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    single_use: z.literal(true),
  }),
  signature: z.string().min(1),
});

function successResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const value = error as { code?: string; message?: string };
  const payload = {
    success: false,
    error: {
      code: value.code ?? 'TOOL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function registerCoreTools(server: McpServer): void {
  server.registerTool(
    'db_inspect_schema',
    {
      title: 'Inspect production schema',
      description: 'Read the production PostgreSQL catalog and return stable SHA-256 schema evidence. Estimated row counts are explicitly separate from the fingerprint.',
      inputSchema: { table_name: z.string().optional() },
      annotations: readonlyAnnotations,
    },
    async (input) => {
      try { return successResult(await inspectSchema(input)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'db_run_readonly_query',
    {
      title: 'Run bounded production read',
      description: 'Run one bounded SELECT/read-only CTE through the database read-only role and a READ ONLY transaction.',
      inputSchema: {
        query: z.string().min(1),
        max_rows: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: readonlyAnnotations,
    },
    async (input) => {
      try { return successResult(await runReadonlyQuery(input)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'analyze_dependencies',
    {
      title: 'Analyze migration dependencies',
      description: 'Map database dependencies for a public table or column before synthesizing migration SQL.',
      inputSchema: {
        table_name: z.string().min(1),
        column_name: z.string().optional(),
      },
      annotations: readonlyAnnotations,
    },
    async (input) => {
      try { return successResult(await analyzeDependencies(input)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'rehearse_migration',
    {
      title: 'Rehearse migration in shadow sandbox',
      description: 'Execute generated SQL inside a serialized, rollback-only shadow transaction. Returns measured timing, lock snapshots, fingerprints, row deltas, notices, explicit assertion results, and rollback equivalence.',
      inputSchema: {
        forward_sql: z.string().min(1),
        rollback_sql: z.string().min(1).optional(),
        verification_assertions: z.array(assertionSchema).min(1).max(20),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try { return successResult(await rehearseMigration(input)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'verify_production',
    {
      title: 'Verify production postconditions',
      description: 'Read-only comparison of the current production schema against a rehearsed fingerprint plus explicit data assertions.',
      inputSchema: {
        expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
        verification_assertions: z.array(assertionSchema).min(1).max(20),
      },
      annotations: readonlyAnnotations,
    },
    async (input) => {
      try { return successResult(await verifyProduction(input)); } catch (error) { return errorResult(error); }
    },
  );
}

function registerExecutorTool(server: McpServer): void {
  server.registerTool(
    'execute_migration',
    {
      title: 'Execute approved production migration',
      description: 'DESTRUCTIVE / HUMAN-GATED. Verify a signed exact-action approval, single-use nonce, baseline fingerprint, atomic SQL policy, and expected post-fingerprint before committing production DDL.',
      inputSchema: {
        migration_sql: z.string().min(1),
        verification_assertions: z.array(assertionSchema).min(1).max(20),
        approval_token: approvalSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try { return successResult(await executeMigration(input)); } catch (error) { return errorResult(error); }
    },
  );
}

function createServer(role: Exclude<ProcessRole, 'cli'>): McpServer {
  const server = new McpServer({
    name: role === 'core' ? 'schemaforge-core' : 'schemaforge-executor',
    version: VERSION,
  });
  if (role === 'core') registerCoreTools(server);
  else registerExecutorTool(server);
  return server;
}

function requestedRole(): Exclude<ProcessRole, 'cli'> {
  const roleIndex = process.argv.indexOf('--role');
  const role = roleIndex >= 0 ? process.argv[roleIndex + 1] : process.env.SF_PROCESS_ROLE ?? 'core';
  if (role !== 'core' && role !== 'executor') {
    throw new Error('--role must be core or executor.');
  }
  return role;
}

function authorized(header: string | undefined, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(apiKey);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function main(): Promise<void> {
  const role = requestedRole();
  const config = loadConfig(role);
  db.configure(role);
  const port = portForRole(config);
  const app = createMcpExpressApp({ host: config.SF_HTTP_HOST });

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: `schemaforge-${role}`, version: VERSION });
  });

  app.use('/mcp', (request, response, next) => {
    if (!authorized(request.header('authorization'), config.SF_MCP_API_KEY)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.post('/mcp', async (request, response) => {
    const server = createServer(role);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error(`[SchemaForge:${role}] MCP request failed:`, error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_request, response) => {
    response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });
  app.delete('/mcp', (_request, response) => {
    response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  const httpServer = app.listen(port, config.SF_HTTP_HOST, () => {
    console.error(`[SchemaForge:${role}] v${VERSION} ready at http://${config.SF_HTTP_HOST}:${port}/mcp`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[SchemaForge:${role}] ${signal}; shutting down.`);
    httpServer.close();
    await db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[SchemaForge] Fatal error:', error);
  process.exit(1);
});
