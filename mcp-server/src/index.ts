/**
 * SchemaForge v2.0 — MCP Server Entry Point.
 *
 * Registers all 6 database migration tools with the Model Context Protocol
 * server and starts listening on stdio transport.
 *
 * Tool registry:
 *   Tier 0 (read-only):
 *     • db_inspect_schema      — Inspect database schema with fingerprinting
 *     • db_run_readonly_query  — Execute read-only SELECT queries
 *     • analyze_dependencies   — Analyze table/column dependency graph
 *     • verify_production      — Post-migration verification
 *
 *   Tier 1 (shadow-only):
 *     • rehearse_migration     — Rehearse migration on shadow database
 *
 *   Tier 2 (GATED — requires ApprovalToken):
 *     • execute_migration      — Apply migration to production
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { inspectSchema } from './tools/inspect_schema.js';
import { runReadonlyQuery } from './tools/readonly_query.js';
import { analyzeDependencies } from './tools/analyze_dependencies.js';
import { rehearseMigration } from './tools/rehearse_migration.js';
import { executeMigration } from './tools/execute_migration.js';
import { verifyProduction } from './tools/verify_production.js';
import { db } from './db.js';

// ─── Server Initialization ─────────────────────────────────────

const server = new McpServer({
  name: 'schemaforge',
  version: '2.0.0',
});

// ─── Tool Registration ─────────────────────────────────────────

/**
 * Tier 0 — db_inspect_schema
 * Inspects the production database schema. Returns table definitions,
 * columns, constraints, indexes, and a cryptographic schema fingerprint.
 */
server.tool(
  'db_inspect_schema',
  'Inspect the production database schema. Returns table definitions, columns, constraints, indexes, and a SHA-256 schema fingerprint for drift detection. Optionally filter to a single table.',
  {
    table_name: z.string().optional().describe('Optional table name to inspect. Omit for full catalog.'),
  },
  async (input) => {
    try {
      const result = await inspectSchema({
        table_name: input.table_name,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

/**
 * Tier 0 — db_run_readonly_query
 * Execute a read-only SELECT query against production.
 */
server.tool(
  'db_run_readonly_query',
  'Execute a read-only SELECT query against the production database. Only SELECT statements are allowed. Results are capped at max_rows (default 100, max 1000).',
  {
    query: z.string().describe('The SELECT query to execute.'),
    max_rows: z.number().int().min(1).max(1000).optional()
      .describe('Maximum number of rows to return. Default 100, max 1000.'),
  },
  async (input) => {
    try {
      const result = await runReadonlyQuery({
        query: input.query,
        max_rows: input.max_rows,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

/**
 * Tier 0 — analyze_dependencies
 * Analyze database-level dependencies for a table/column.
 */
server.tool(
  'analyze_dependencies',
  'Analyze database-level dependencies for a table (and optionally a column). Returns foreign keys, dependent views, functions/triggers, and indexes to assess the blast radius of a proposed schema change.',
  {
    table_name: z.string().describe('The table to analyze.'),
    column_name: z.string().optional().describe('Optional column to narrow dependency analysis.'),
  },
  async (input) => {
    try {
      const result = await analyzeDependencies({
        table_name: input.table_name,
        column_name: input.column_name,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

/**
 * Tier 1 — rehearse_migration
 * Rehearse a migration on the shadow database (no production impact).
 */
server.tool(
  'rehearse_migration',
  'Rehearse a migration on the disposable shadow database. Executes the forward SQL, runs verification queries, and optionally tests the rollback SQL. Never touches production.',
  {
    forward_sql: z.string().describe('The forward migration SQL to rehearse.'),
    rollback_sql: z.string().optional()
      .describe('Optional rollback SQL to verify reversibility.'),
    verification_queries: z.array(z.string())
      .describe('Queries to run after forward migration to verify expected state.'),
  },
  async (input) => {
    try {
      const result = await rehearseMigration({
        forward_sql: input.forward_sql,
        rollback_sql: input.rollback_sql,
        verification_queries: input.verification_queries,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

/**
 * Tier 2 — execute_migration (GATED)
 * Apply a migration to the production database. Requires a valid ApprovalToken.
 */
server.tool(
  'execute_migration',
  'GATED: Apply a migration to the production database. Requires a valid ApprovalToken with matching SHA-256 hash, valid expiry, and target="prod". This is the ONLY tool that mutates production.',
  {
    migration_sql: z.string().describe('The SQL to execute against production.'),
    approval_token: z.object({
      migration_hash: z.string().describe('SHA-256 hash of the migration SQL.'),
      target: z.string().describe('Target database identifier (must be "prod").'),
      action: z.string().describe('Human-readable action description.'),
      created_at: z.string().describe('ISO-8601 creation timestamp.'),
      expires_at: z.string().describe('ISO-8601 expiry timestamp.'),
      single_use: z.boolean().describe('Whether this token is single-use.'),
      used: z.boolean().describe('Whether this token has been consumed.'),
    }).describe('The human-issued approval token authorizing this mutation.'),
  },
  async (input) => {
    try {
      const result = await executeMigration({
        migration_sql: input.migration_sql,
        approval_token: input.approval_token,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

/**
 * Tier 0 — verify_production
 * Post-migration verification against production (read-only).
 */
server.tool(
  'verify_production',
  'Post-migration verification. Checks that expected schema/data changes are present in production after a migration. Runs verification queries and smoke tests. Read-only.',
  {
    table_name: z.string().describe('The table that was modified.'),
    expected_changes: z.array(z.string())
      .describe('Verification queries/assertions to check against production.'),
  },
  async (input) => {
    try {
      const result = await verifyProduction({
        table_name: input.table_name,
        expected_changes: input.expected_changes,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ─── Server Startup ─────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.error('[SchemaForge] Shutting down…');
    await db.close();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[SchemaForge] Shutting down…');
    await db.close();
    await server.close();
    process.exit(0);
  });

  console.error('[SchemaForge] MCP Server v2.0.0 starting on stdio transport…');
  await server.connect(transport);
  console.error('[SchemaForge] MCP Server v2.0.0 ready. 6 tools registered.');
}

main().catch((err) => {
  console.error('[SchemaForge] Fatal error:', err);
  process.exit(1);
});
