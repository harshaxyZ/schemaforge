/**
 * SchemaForge v2.0 — Tool: db_run_readonly_query
 * Safety Tier: 0 (read-only, no approval needed)
 *
 * Executes an arbitrary SELECT query against the production database using
 * the sf_reader role. The query is validated to ensure it is read-only:
 *   1. Only SELECT statements are allowed (no INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE).
 *   2. Row count is capped at max_rows (default 100, max 1000).
 *   3. statement_timeout is enforced by the DatabaseManager.
 *
 * This tool is the agent's primary means of inspecting live data to make
 * informed migration decisions (e.g. checking null ratios, data distributions).
 */

import { db } from '../db.js';

export interface RunReadonlyQueryInput {
  /** The SELECT query to execute. */
  query: string;
  /** Maximum rows to return. Default 100, max 1000. */
  max_rows?: number;
}

export interface RunReadonlyQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
}

/** Statements that are prohibited in read-only mode. */
const PROHIBITED_PATTERNS = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|COMMENT|SECURITY|SET\s+ROLE|RESET\s+ROLE)\b/i;

/**
 * Execute a read-only query against production.
 *
 * @param input — query string and optional row limit
 * @returns column names, row data, and whether results were truncated
 * @throws if the query contains prohibited statements
 */
export async function runReadonlyQuery(input: RunReadonlyQueryInput): Promise<RunReadonlyQueryResult> {
  const { query } = input;
  const maxRows = Math.min(Math.max(input.max_rows ?? 100, 1), 1000);

  // ── Safety: reject anything that is not a SELECT ──
  if (PROHIBITED_PATTERNS.test(query)) {
    throw new Error(
      'Query rejected: only SELECT statements are allowed on the read-only connection. ' +
        'Detected a prohibited statement keyword.',
    );
  }

  // ── Strip trailing semicolon if present ──
  const cleanQuery = query.trim().replace(/;+$/, '');

  // ── Wrap with LIMIT to enforce row cap ──
  const wrappedQuery = `SELECT * FROM (${cleanQuery}) AS __sf_readonly LIMIT ${maxRows + 1}`;

  const result = await db.query('prodReadonly', wrappedQuery);

  const truncated = result.rows.length > maxRows;
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
  const columns = result.fields?.map((f) => f.name) ?? [];

  return {
    columns,
    rows: rows as Record<string, unknown>[],
    row_count: rows.length,
    truncated,
  };
}
