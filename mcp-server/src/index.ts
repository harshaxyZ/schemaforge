/**
 * SchemaForge v2.0 — MCP Server Entry Point.
 *
 * Registers all 6 database migration tools with the Model Context Protocol
 * server and supports HTTP (Express + StreamableHTTP / SSE) and Stdio transports.
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

import { inspectSchema } from './tools/inspect_schema.js';
import { runReadonlyQuery } from './tools/readonly_query.js';
import { analyzeDependencies } from './tools/analyze_dependencies.js';
import { rehearseMigration } from './tools/rehearse_migration.js';
import { executeMigration } from './tools/execute_migration.js';
import { verifyProduction } from './tools/verify_production.js';
import { db } from './db.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'schemaforge',
    version: '2.0.0',
  });

  // ── Tier 0 — db_inspect_schema ──
  server.tool(
    'db_inspect_schema',
    'Inspect the production database schema. Returns table definitions, columns, constraints, indexes, and a SHA-256 schema fingerprint for drift detection.',
    {
      table_name: z.string().optional().describe('Optional table name to inspect. Omit for full catalog.'),
    },
    async (input) => {
      try {
        const result = await inspectSchema({ table_name: input.table_name });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tier 0 — db_run_readonly_query ──
  server.tool(
    'db_run_readonly_query',
    'Execute a read-only SELECT query against the production database. Only SELECT statements are allowed. Capped at max_rows.',
    {
      query: z.string().describe('The SELECT query to execute.'),
      max_rows: z.number().int().min(1).max(1000).optional().describe('Max rows (default 100, max 1000).'),
    },
    async (input) => {
      try {
        const result = await runReadonlyQuery({ query: input.query, max_rows: input.max_rows });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tier 0 — analyze_dependencies ──
  server.tool(
    'analyze_dependencies',
    'Analyze database-level dependencies for a table (and optionally a column). Returns foreign keys, dependent views, functions/triggers, and indexes.',
    {
      table_name: z.string().describe('The table to analyze.'),
      column_name: z.string().optional().describe('Optional column to narrow dependency analysis.'),
    },
    async (input) => {
      try {
        const result = await analyzeDependencies({ table_name: input.table_name, column_name: input.column_name });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tier 1 — rehearse_migration ──
  server.tool(
    'rehearse_migration',
    'Rehearse a migration on the disposable shadow database. Executes forward SQL, runs verification queries, and optionally tests rollback SQL. Never touches production.',
    {
      forward_sql: z.string().describe('The forward migration SQL to rehearse.'),
      rollback_sql: z.string().optional().describe('Optional rollback SQL to verify reversibility.'),
      verification_queries: z.array(z.string()).describe('Queries to run after forward migration to verify expected state.'),
    },
    async (input) => {
      try {
        const result = await rehearseMigration({
          forward_sql: input.forward_sql,
          rollback_sql: input.rollback_sql,
          verification_queries: input.verification_queries,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tier 2 — execute_migration ──
  server.tool(
    'execute_migration',
    'GATED: Apply a migration to the production database. Requires a valid signed ApprovalToken. This is the ONLY tool that mutates production.',
    {
      migration_sql: z.string().describe('The SQL to execute against production.'),
      verification_assertions: z.array(z.object({
        name: z.string().describe('Human-readable assertion name.'),
        query: z.string().describe('SQL SELECT query for verification.'),
        expectation: z.enum(['returns_rows', 'returns_no_rows', 'first_value_true', 'scalar_equals']).describe('Expected result pattern.'),
        expected_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional().describe('Expected scalar value (for scalar_equals).'),
      })).describe('Verification assertions to check after migration.'),
      approval_token: z.object({
        payload: z.object({
          version: z.literal(1),
          nonce: z.string(),
          migration_hash: z.string(),
          assertions_hash: z.string(),
          baseline_fingerprint: z.string(),
          expected_fingerprint: z.string(),
          rehearsal_id: z.string(),
          target: z.string(),
          action: z.string(),
          issued_at: z.string(),
          expires_at: z.string(),
          single_use: z.literal(true),
        }).describe('The signed approval payload.'),
        signature: z.string().describe('HMAC-SHA256 base64url signature of the payload.'),
      }).describe('The human-issued signed approval token authorizing this mutation.'),
    },
    async (input) => {
      try {
        const result = await executeMigration({
          migration_sql: input.migration_sql,
          verification_assertions: input.verification_assertions as any,
          approval_token: input.approval_token as any,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tier 0 — verify_production ──
  server.tool(
    'verify_production',
    'Post-migration verification. Checks schema fingerprint and runs verification assertions against production. Read-only.',
    {
      expected_fingerprint: z.string().describe('The expected SHA-256 schema fingerprint after migration.'),
      verification_assertions: z.array(z.object({
        name: z.string().describe('Human-readable assertion name.'),
        query: z.string().describe('SQL SELECT query for verification.'),
        expectation: z.enum(['returns_rows', 'returns_no_rows', 'first_value_true', 'scalar_equals']).describe('Expected result pattern.'),
        expected_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional().describe('Expected scalar value (for scalar_equals).'),
      })).describe('Verification assertions to run against production.'),
    },
    async (input) => {
      try {
        const result = await verifyProduction({
          expected_fingerprint: input.expected_fingerprint,
          verification_assertions: input.verification_assertions as any,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  return server;
}

// ─── Server Startup ─────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = process.env.MCP_MODE || 'http';
  const port = parseInt(process.env.MCP_PORT || '4000', 10);

  if (mode === 'stdio') {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    console.error('[SchemaForge] MCP Server starting on stdio transport...');
    await server.connect(transport);
    console.error('[SchemaForge] MCP Server ready on stdio transport.');
    return;
  }

  // HTTP Transport (Express)
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'schemaforge', version: '2.0.0' });
  });

  // Stateless Streamable HTTP transport
  const streamableTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const streamableServer = createMcpServer();
  await streamableServer.connect(streamableTransport);

  app.all('/mcp', async (req, res) => {
    try {
      await streamableTransport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[SchemaForge] Error handling /mcp request:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: String(err) });
      }
    }
  });

  // SSE Transport sessions
  const sseSessions = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    try {
      console.log('[SchemaForge] Incoming SSE connection request');
      const sseTransport = new SSEServerTransport('/message', res);
      const sseServer = createMcpServer();
      await sseServer.connect(sseTransport);
      sseSessions.set(sseTransport.sessionId, sseTransport);
      console.log(`[SchemaForge] SSE session established: ${sseTransport.sessionId}`);

      req.on('close', () => {
        console.log(`[SchemaForge] SSE session closed: ${sseTransport.sessionId}`);
        sseSessions.delete(sseTransport.sessionId);
      });
    } catch (err) {
      console.error('[SchemaForge] Error in SSE endpoint:', err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.post('/message', async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      console.log(`[SchemaForge] Incoming POST message for session: ${sessionId}`);
      const transport = sseSessions.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        console.error(`[SchemaForge] Session not found: ${sessionId}`);
        res.status(400).json({ error: 'Session not found or expired' });
      }
    } catch (err) {
      console.error('[SchemaForge] Error in /message endpoint:', err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.listen(port, () => {
    console.log(`[SchemaForge] MCP HTTP Server v2.0.0 listening on http://0.0.0.0:${port}`);
    console.log(`[SchemaForge] Endpoints: GET /health | ALL /mcp | GET /sse`);
  });

  process.on('SIGINT', async () => {
    console.log('[SchemaForge] Shutting down...');
    await db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[SchemaForge] Fatal error:', err);
  process.exit(1);
});
