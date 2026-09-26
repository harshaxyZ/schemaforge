/** Bounded, transaction-level read-only production query tool. */

import { db } from '../db.js';
import { requireReadonlyQuery } from '../security/sql_policy.js';

export interface RunReadonlyQueryInput {
  query: string;
  max_rows?: number;
}

export interface RunReadonlyQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
}

function configuredRowCap(): number {
  const parsed = Number.parseInt(process.env.SF_MAX_RESULT_ROWS ?? '1000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000;
}

export async function runReadonlyQuery(
  input: RunReadonlyQueryInput,
): Promise<RunReadonlyQueryResult> {
  const query = requireReadonlyQuery(input.query);
  const hardCap = configuredRowCap();
  const maxRows = Math.min(Math.max(input.max_rows ?? 100, 1), hardCap);

  return db.withTransaction(
    'prodReadonly',
    async (client) => {
      const result = await client.query(
        `SELECT * FROM (${query}) AS __sf_readonly LIMIT ${maxRows + 1}`,
      );
      const truncated = result.rows.length > maxRows;
      const rows = (truncated ? result.rows.slice(0, maxRows) : result.rows) as Record<string, unknown>[];
      return {
        columns: result.fields.map((field) => field.name),
        rows,
        row_count: rows.length,
        truncated,
      };
    },
    { readOnly: true },
  );
}
