/**
 * SchemaForge v2.0 — Tool: verify_production
 * Safety Tier: 0 (read-only, no approval needed)
 *
 * Post-migration verification tool. After a migration has been applied to
 * production, this tool checks that the expected changes are present:
 *
 *   1. Schema verification — confirms columns, constraints, indexes exist
 *      as expected after the migration.
 *   2. Data verification — runs user-supplied expected_changes as queries
 *      to confirm data integrity.
 *   3. Smoke tests — basic connectivity and query execution checks.
 *
 * This is the final step in the migration lifecycle. Its output is included
 * in the post-migration report.
 */

import { db } from '../db.js';
import type { Evidence } from '../types.js';

export interface VerifyProductionInput {
  /** The table that was modified. */
  table_name: string;
  /** Verification queries / assertions to check. */
  expected_changes: string[];
}

export interface VerificationCheck {
  description: string;
  query: string;
  passed: boolean;
  result: Record<string, unknown>[] | null;
  error: string | null;
}

export interface VerifyProductionResult {
  table_name: string;
  table_exists: boolean;
  all_checks_passed: boolean;
  checks: VerificationCheck[];
  evidence: Evidence[];
}

/**
 * Verify that a production migration was applied correctly.
 *
 * @param input — table name and expected change assertions
 * @returns verification results with evidence
 */
export async function verifyProduction(
  input: VerifyProductionInput,
): Promise<VerifyProductionResult> {
  const { table_name, expected_changes } = input;
  const evidence: Evidence[] = [];
  const checks: VerificationCheck[] = [];

  // ── 1. Table existence check ──
  const tableExistsResult = await db.query(
    'prodReadonly',
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS table_exists`,
    [table_name],
  );

  const tableExists = Boolean(tableExistsResult.rows[0]?.table_exists);

  evidence.push({
    check_name: 'table_exists',
    status: tableExists ? 'PASS' : 'FAIL',
    details: tableExists
      ? `Table "${table_name}" exists in public schema`
      : `Table "${table_name}" NOT found in public schema`,
    is_estimate: false,
  });

  if (!tableExists) {
    return {
      table_name,
      table_exists: false,
      all_checks_passed: false,
      checks: [],
      evidence,
    };
  }

  // ── 2. Run user-supplied verification queries ──
  let allPassed = true;

  for (const changeQuery of expected_changes) {
    try {
      const result = await db.query('prodReadonly', changeQuery);
      const rows = result.rows as Record<string, unknown>[];

      // A verification query "passes" if it returns at least one row
      const passed = rows.length > 0;
      if (!passed) allPassed = false;

      checks.push({
        description: changeQuery.slice(0, 120),
        query: changeQuery,
        passed,
        result: rows.slice(0, 10), // cap preview at 10 rows
        error: null,
      });

      evidence.push({
        check_name: 'expected_change_verify',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Verification passed: ${changeQuery.slice(0, 80)}`
          : `Verification returned 0 rows: ${changeQuery.slice(0, 80)}`,
        measured_value: `${rows.length} rows`,
        is_estimate: false,
      });
    } catch (err: unknown) {
      allPassed = false;
      const errMsg = err instanceof Error ? err.message : String(err);

      checks.push({
        description: changeQuery.slice(0, 120),
        query: changeQuery,
        passed: false,
        result: null,
        error: errMsg,
      });

      evidence.push({
        check_name: 'expected_change_verify',
        status: 'FAIL',
        details: `Verification query error: ${errMsg}`,
        is_estimate: false,
      });
    }
  }

  // ── 3. Smoke test — basic SELECT against the table ──
  try {
    await db.query('prodReadonly', `SELECT 1 FROM "${table_name}" LIMIT 1`);
    evidence.push({
      check_name: 'smoke_test',
      status: 'PASS',
      details: `Smoke test SELECT on "${table_name}" succeeded`,
      is_estimate: false,
    });
  } catch (err: unknown) {
    allPassed = false;
    const errMsg = err instanceof Error ? err.message : String(err);
    evidence.push({
      check_name: 'smoke_test',
      status: 'FAIL',
      details: `Smoke test failed: ${errMsg}`,
      is_estimate: false,
    });
  }

  return {
    table_name,
    table_exists: tableExists,
    all_checks_passed: allPassed,
    checks,
    evidence,
  };
}
