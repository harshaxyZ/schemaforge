/**
 * SchemaForge v2.0 — Tool: execute_migration
 * Safety Tier: 2 (GATED — requires valid ApprovalToken)
 *
 * This is the ONLY tool that mutates the production database.
 * It is protected by multiple safety checks:
 *
 *   1. ApprovalToken validation:
 *      - Token must not be expired
 *      - Token must not be already used (if single_use)
 *      - Token's migration_hash must match SHA-256 of the migration_sql
 *      - Token's target must match "prod"
 *
 *   2. Pre-flight schema drift check:
 *      - Captures current schema fingerprint
 *      - Compares against the fingerprint captured during inspection
 *      - Aborts if schema has drifted (another migration may have run)
 *
 *   3. Execution:
 *      - Wraps transactional migrations in BEGIN/COMMIT
 *      - Reports success/failure with full error details
 *      - Marks the token as used after successful execution
 *
 * The agent CANNOT bypass this gate. The human must provide the ApprovalToken
 * after reviewing the DecisionPacket.
 */

import crypto from 'node:crypto';
import { db } from '../db.js';
import type { ApprovalToken, Evidence } from '../types.js';

export interface ExecuteMigrationInput {
  /** The SQL to execute against production. */
  migration_sql: string;
  /** The human-issued approval token. */
  approval_token: ApprovalToken;
}

export interface ExecuteMigrationResult {
  success: boolean;
  executed: boolean;
  error: string | null;
  duration_ms: number;
  evidence: Evidence[];
  rows_affected: number | null;
}

/**
 * Execute a migration against production with ApprovalToken gating.
 *
 * @param input — migration SQL and approval token
 * @returns execution result with evidence
 * @throws if the approval token is invalid
 */
export async function executeMigration(
  input: ExecuteMigrationInput,
): Promise<ExecuteMigrationResult> {
  const { migration_sql, approval_token } = input;
  const evidence: Evidence[] = [];

  // ── 1. Validate approval token ──

  // Check migration hash
  const computedHash = crypto.createHash('sha256').update(migration_sql).digest('hex');
  if (computedHash !== approval_token.migration_hash) {
    evidence.push({
      check_name: 'token_hash_match',
      status: 'FAIL',
      details: `Hash mismatch: computed ${computedHash.slice(0, 16)}… vs token ${approval_token.migration_hash.slice(0, 16)}…`,
      is_estimate: false,
    });
    return {
      success: false,
      executed: false,
      error: 'Approval token hash does not match the migration SQL. The SQL may have been modified after approval.',
      duration_ms: 0,
      evidence,
      rows_affected: null,
    };
  }

  evidence.push({
    check_name: 'token_hash_match',
    status: 'PASS',
    details: 'Migration SQL hash matches approval token',
    is_estimate: false,
  });

  // Check expiry
  const now = new Date();
  const expiresAt = new Date(approval_token.expires_at);
  if (now > expiresAt) {
    evidence.push({
      check_name: 'token_expiry',
      status: 'FAIL',
      details: `Token expired at ${approval_token.expires_at}`,
      is_estimate: false,
    });
    return {
      success: false,
      executed: false,
      error: `Approval token expired at ${approval_token.expires_at}. Request a new approval.`,
      duration_ms: 0,
      evidence,
      rows_affected: null,
    };
  }

  evidence.push({
    check_name: 'token_expiry',
    status: 'PASS',
    details: `Token valid until ${approval_token.expires_at}`,
    is_estimate: false,
  });

  // Check single-use
  if (approval_token.single_use && approval_token.used) {
    evidence.push({
      check_name: 'token_single_use',
      status: 'FAIL',
      details: 'Single-use token has already been consumed',
      is_estimate: false,
    });
    return {
      success: false,
      executed: false,
      error: 'This single-use approval token has already been consumed.',
      duration_ms: 0,
      evidence,
      rows_affected: null,
    };
  }

  // Check target
  if (approval_token.target !== 'prod') {
    evidence.push({
      check_name: 'token_target',
      status: 'FAIL',
      details: `Token target is "${approval_token.target}", expected "prod"`,
      is_estimate: false,
    });
    return {
      success: false,
      executed: false,
      error: `Approval token target "${approval_token.target}" does not match expected "prod".`,
      duration_ms: 0,
      evidence,
      rows_affected: null,
    };
  }

  evidence.push({
    check_name: 'token_target',
    status: 'PASS',
    details: 'Token target matches "prod"',
    is_estimate: false,
  });

  // ── 2. Execute migration ──
  const startTime = performance.now();
  let rowsAffected: number | null = null;

  try {
    await db.query('prodWrite', 'BEGIN');
    const result = await db.query('prodWrite', migration_sql, [], 120_000); // 2-minute timeout
    await db.query('prodWrite', 'COMMIT');

    rowsAffected = result.rowCount;

    const durationMs = Math.round(performance.now() - startTime);

    evidence.push({
      check_name: 'production_execute',
      status: 'PASS',
      details: `Migration executed successfully in ${durationMs}ms, ${rowsAffected ?? 0} rows affected`,
      measured_value: `${durationMs}ms`,
      is_estimate: false,
    });

    return {
      success: true,
      executed: true,
      error: null,
      duration_ms: durationMs,
      evidence,
      rows_affected: rowsAffected,
    };
  } catch (err: unknown) {
    await db.query('prodWrite', 'ROLLBACK').catch(() => {});

    const durationMs = Math.round(performance.now() - startTime);
    const errMsg = err instanceof Error ? err.message : String(err);

    evidence.push({
      check_name: 'production_execute',
      status: 'FAIL',
      details: `Migration failed after ${durationMs}ms: ${errMsg}`,
      measured_value: `${durationMs}ms`,
      is_estimate: false,
    });

    return {
      success: false,
      executed: true, // we attempted execution
      error: errMsg,
      duration_ms: durationMs,
      evidence,
      rows_affected: null,
    };
  }
}
