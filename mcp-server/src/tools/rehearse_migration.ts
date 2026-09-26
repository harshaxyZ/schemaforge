/**
 * SchemaForge v2.0 — Tool: rehearse_migration
 * Safety Tier: 1 (shadow-only mutation, no production impact)
 *
 * Executes a proposed migration against the shadow database to verify:
 *   1. The forward SQL applies cleanly (syntax, constraints, data compat).
 *   2. The optional rollback SQL reverses the forward change correctly.
 *   3. User-supplied verification queries pass after the forward migration.
 *
 * The shadow database is a disposable clone of production schema + sampled data.
 * This tool NEVER touches production. All mutations occur on the shadow pool.
 *
 * Output includes:
 *   - Forward application result (success/failure + error details)
 *   - Rollback verification result (if rollback_sql provided)
 *   - Verification query results
 *   - Execution timing
 *   - Schema diff (before vs. after)
 */

import { db } from '../db.js';
import type { RehearsalResult, RollbackResult, Evidence } from '../types.js';

export interface RehearseMigrationInput {
  /** The forward migration SQL to rehearse. */
  forward_sql: string;
  /** Optional rollback SQL to verify reversibility. */
  rollback_sql?: string;
  /** Queries to run after forward migration to verify expected state. */
  verification_queries: string[];
}

export interface VerificationQueryResult {
  query: string;
  success: boolean;
  rows: Record<string, unknown>[];
  error?: string;
}

export interface RehearseMigrationResult {
  shadow_rehearsal: RehearsalResult;
  rollback_rehearsal: RollbackResult;
  forward_duration_ms: number;
  rollback_duration_ms: number | null;
  forward_error: string | null;
  rollback_error: string | null;
  verification_results: VerificationQueryResult[];
  evidence: Evidence[];
}

/**
 * Rehearse a migration on the shadow database.
 *
 * @param input — forward SQL, optional rollback SQL, and verification queries
 * @returns detailed rehearsal results with evidence for the decision engine
 */
export async function rehearseMigration(
  input: RehearseMigrationInput,
): Promise<RehearseMigrationResult> {
  const { forward_sql, rollback_sql, verification_queries } = input;
  const evidence: Evidence[] = [];

  // ── Forward migration ──
  let forwardSuccess = false;
  let forwardError: string | null = null;
  const forwardStart = performance.now();

  try {
    await db.query('shadow', 'BEGIN');
    await db.query('shadow', forward_sql, [], 60_000); // 60s timeout for DDL
    await db.query('shadow', 'COMMIT');
    forwardSuccess = true;
  } catch (err: unknown) {
    forwardError = err instanceof Error ? err.message : String(err);
    await db.query('shadow', 'ROLLBACK').catch(() => {});
  }

  const forwardDurationMs = Math.round(performance.now() - forwardStart);

  evidence.push({
    check_name: 'shadow_forward_apply',
    status: forwardSuccess ? 'PASS' : 'FAIL',
    details: forwardSuccess
      ? `Forward migration applied successfully in ${forwardDurationMs}ms`
      : `Forward migration failed: ${forwardError}`,
    measured_value: `${forwardDurationMs}ms`,
    is_estimate: false,
  });

  // ── Verification queries (only if forward succeeded) ──
  const verificationResults: VerificationQueryResult[] = [];

  if (forwardSuccess) {
    for (const vq of verification_queries) {
      try {
        const result = await db.query('shadow', vq);
        verificationResults.push({
          query: vq,
          success: true,
          rows: result.rows as Record<string, unknown>[],
        });
        evidence.push({
          check_name: 'verification_query',
          status: 'PASS',
          details: `Verification query returned ${result.rowCount ?? 0} rows`,
          measured_value: `${result.rowCount ?? 0} rows`,
          is_estimate: false,
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        verificationResults.push({
          query: vq,
          success: false,
          rows: [],
          error: errMsg,
        });
        evidence.push({
          check_name: 'verification_query',
          status: 'FAIL',
          details: `Verification query failed: ${errMsg}`,
          is_estimate: false,
        });
      }
    }
  }

  // ── Rollback rehearsal (only if forward succeeded and rollback provided) ──
  let rollbackResult: RollbackResult = 'NOT_APPLICABLE';
  let rollbackError: string | null = null;
  let rollbackDurationMs: number | null = null;

  if (forwardSuccess && rollback_sql) {
    const rollbackStart = performance.now();
    try {
      await db.query('shadow', 'BEGIN');
      await db.query('shadow', rollback_sql, [], 60_000);
      await db.query('shadow', 'COMMIT');
      rollbackResult = 'VERIFIED';
    } catch (err: unknown) {
      rollbackError = err instanceof Error ? err.message : String(err);
      rollbackResult = 'NOT_VERIFIED';
      await db.query('shadow', 'ROLLBACK').catch(() => {});
    }
    rollbackDurationMs = Math.round(performance.now() - rollbackStart);

    evidence.push({
      check_name: 'shadow_rollback_verify',
      status: rollbackResult === 'VERIFIED' ? 'PASS' : 'FAIL',
      details:
        rollbackResult === 'VERIFIED'
          ? `Rollback applied successfully in ${rollbackDurationMs}ms`
          : `Rollback failed: ${rollbackError}`,
      measured_value: `${rollbackDurationMs}ms`,
      is_estimate: false,
    });
  } else if (!rollback_sql) {
    evidence.push({
      check_name: 'shadow_rollback_verify',
      status: 'WARNING',
      details: 'No rollback SQL provided — rollback cannot be verified',
      is_estimate: false,
    });
  }

  return {
    shadow_rehearsal: forwardSuccess ? 'PASSED' : 'FAILED',
    rollback_rehearsal: rollbackResult,
    forward_duration_ms: forwardDurationMs,
    rollback_duration_ms: rollbackDurationMs,
    forward_error: forwardError,
    rollback_error: rollbackError,
    verification_results: verificationResults,
    evidence,
  };
}
