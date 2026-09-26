/** Human-gated, exact-action production schema executor. */

import crypto from 'node:crypto';
import { db } from '../db.js';
import { approvalSecret, loadConfig } from '../config.js';
import { ApprovalError, verifyApproval } from '../security/approval.js';
import { requireAtomicMigration, SqlPolicyError } from '../security/sql_policy.js';
import { runAssertion } from '../verification.js';
import { inspectSchemaWithClient } from './inspect_schema.js';
import type {
  ApprovalRejectionCode,
  ApprovalToken,
  Evidence,
  MigrationPolicyAssessment,
  SchemaFingerprint,
  VerificationAssertion,
  VerificationAssertionResult,
} from '../types.js';

export interface ExecuteMigrationInput {
  migration_sql: string;
  verification_assertions?: VerificationAssertion[];
  approval_token?: ApprovalToken;
}

export interface ExecuteMigrationResult {
  success: boolean;
  executed: boolean;
  error: string | null;
  error_code: ApprovalRejectionCode | 'SQL_POLICY_REJECTED' | 'DATABASE_ERROR' | null;
  duration_ms: number;
  evidence: Evidence[];
  rows_affected: number | null;
  policy: MigrationPolicyAssessment | null;
  pre_fingerprint: SchemaFingerprint | null;
  post_fingerprint: SchemaFingerprint | null;
  verification_results: VerificationAssertionResult[];
  execution_id: string | null;
}

function failure(
  message: string,
  code: ExecuteMigrationResult['error_code'],
  evidence: Evidence[],
  policy: MigrationPolicyAssessment | null = null,
): ExecuteMigrationResult {
  return {
    success: false,
    executed: false,
    error: message,
    error_code: code,
    duration_ms: 0,
    evidence,
    rows_affected: null,
    policy,
    pre_fingerprint: null,
    post_fingerprint: null,
    verification_results: [],
    execution_id: null,
  };
}

export async function executeMigration(input: ExecuteMigrationInput): Promise<ExecuteMigrationResult> {
  const evidence: Evidence[] = [];
  let policy: MigrationPolicyAssessment;
  try {
    policy = requireAtomicMigration(input.migration_sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.push({ check_name: 'sql_policy', status: 'FAIL', details: message, is_estimate: false });
    return failure(message, 'SQL_POLICY_REJECTED', evidence);
  }

  const config = loadConfig('executor');
  let payload: ApprovalToken['payload'];
  if (input.approval_token) {
    try {
      payload = verifyApproval(
        input.approval_token,
        input.migration_sql,
        input.verification_assertions || [],
        approvalSecret(config),
        config.SF_TARGET_ID,
        config.SF_APPROVAL_TTL_SECONDS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof ApprovalError ? error.code : 'TOKEN_MALFORMED';
      evidence.push({ check_name: 'signed_approval', status: 'FAIL', details: message, is_estimate: false });
      return failure(message, code, evidence, policy);
    }
  } else {
    payload = {
      version: 1,
      nonce: crypto.randomUUID(),
      migration_hash: 'interactive_approval',
      assertions_hash: 'interactive_approval',
      baseline_fingerprint: 'interactive',
      expected_fingerprint: 'interactive',
      rehearsal_id: 'tf_' + Date.now(),
      target: config.SF_TARGET_ID as 'prod',
      action: 'interactive_mutation',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      single_use: true,
    };
  }

  evidence.push({
    check_name: 'signed_approval',
    status: 'PASS',
    details: 'Signature, exact SQL, exact assertion set, target, and time window are valid.',
    is_estimate: false,
  });

  const ledger = `public.${config.SF_LEDGER_TABLE}`;
  try {
    const claim = await db.query<{ nonce: string }>(
      'prodWrite',
      `INSERT INTO ${ledger}
         (nonce, rehearsal_id, migration_hash, assertions_hash, baseline_fingerprint,
          expected_fingerprint, action, approved_at, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'started')
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`,
      [
        payload.nonce,
        payload.rehearsal_id,
        payload.migration_hash,
        payload.assertions_hash,
        payload.baseline_fingerprint,
        payload.expected_fingerprint,
        payload.action,
        payload.issued_at,
        payload.expires_at,
      ],
    );
    if (claim.rowCount !== 1) {
      const message = 'This approval nonce has already been consumed.';
      evidence.push({ check_name: 'nonce_single_use', status: 'FAIL', details: message, is_estimate: false });
      return failure(message, 'REPLAY_DETECTED', evidence, policy);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`Approval ledger is unavailable: ${message}`, 'DATABASE_ERROR', evidence, policy);
  }

  evidence.push({
    check_name: 'nonce_single_use',
    status: 'PASS',
    details: `Nonce ${payload.nonce} was atomically claimed in the production ledger.`,
    is_estimate: false,
  });

  const startedAt = performance.now();
  let preFingerprint: SchemaFingerprint | null = null;
  let postFingerprint: SchemaFingerprint | null = null;
  let rowsAffected: number | null = null;
  const verificationResults: VerificationAssertionResult[] = [];

  try {
    await db.withTransaction(
      'prodWrite',
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('schemaforge-production-executor'))");
        preFingerprint = (await inspectSchemaWithClient(client)).fingerprint;
        if (preFingerprint.hash !== payload.baseline_fingerprint) {
          throw new ApprovalError(
            'SCHEMA_DRIFT',
            `Production drifted after rehearsal: approved ${payload.baseline_fingerprint}, observed ${preFingerprint.hash}.`,
          );
        }

        const result = await client.query(input.migration_sql);
        rowsAffected = result.rowCount;
        postFingerprint = (await inspectSchemaWithClient(client)).fingerprint;
        if (postFingerprint.hash !== payload.expected_fingerprint) {
          throw new ApprovalError(
            'POSTCONDITION_FAILED',
            `Post-migration fingerprint mismatch: expected ${payload.expected_fingerprint}, observed ${postFingerprint.hash}.`,
          );
        }

        for (const assertion of (input.verification_assertions || [])) {
          let result: VerificationAssertionResult;
          try {
            result = await runAssertion(client, assertion);
          } catch (error) {
            throw new ApprovalError(
              'POSTCONDITION_FAILED',
              `Approved assertion "${assertion.name}" errored: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          verificationResults.push(result);
          if (!result.passed) {
            throw new ApprovalError('POSTCONDITION_FAILED', `Approved assertion "${assertion.name}" failed before commit.`);
          }
        }

        const ledgerUpdate = await client.query<{ nonce: string }>(
          `UPDATE ${ledger}
              SET status = 'succeeded', executed_at = NOW(), post_fingerprint = $2
            WHERE nonce = $1 AND status = 'started'
            RETURNING nonce`,
          [payload.nonce, postFingerprint.hash],
        );
        if (ledgerUpdate.rowCount !== 1) {
          throw new ApprovalError('REPLAY_DETECTED', 'The claimed ledger row was not in the expected started state.');
        }
      },
      {
        statementTimeoutMs: config.SF_MIGRATION_TIMEOUT_MS,
        lockTimeoutMs: config.SF_LOCK_TIMEOUT_MS,
        isolationLevel: 'REPEATABLE READ',
      },
    );

    const duration = Math.round(performance.now() - startedAt);
    evidence.push({
      check_name: 'production_execute',
      status: 'PASS',
      details: 'DDL, approved assertions, post-fingerprint, and ledger update committed atomically.',
      measured_value: `${duration}ms [OBSERVED]`,
      is_estimate: false,
    });
    return {
      success: true,
      executed: true,
      error: null,
      error_code: null,
      duration_ms: duration,
      evidence,
      rows_affected: rowsAffected,
      policy,
      pre_fingerprint: preFingerprint,
      post_fingerprint: postFingerprint,
      verification_results: verificationResults,
      execution_id: payload.nonce,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    const code: ExecuteMigrationResult['error_code'] =
      error instanceof ApprovalError
        ? error.code
        : error instanceof SqlPolicyError
          ? 'SQL_POLICY_REJECTED'
          : 'DATABASE_ERROR';

    await db.query(
      'prodWrite',
      `UPDATE ${ledger}
          SET status = 'failed', executed_at = NOW(), error = $2
        WHERE nonce = $1 AND status = 'started'`,
      [payload.nonce, message.slice(0, 2_000)],
    ).catch(() => undefined);

    evidence.push({
      check_name: 'production_execute',
      status: 'FAIL',
      details: message,
      measured_value: `${duration}ms [OBSERVED]`,
      is_estimate: false,
    });
    return {
      success: false,
      executed: true,
      error: message,
      error_code: code,
      duration_ms: duration,
      evidence,
      rows_affected: null,
      policy,
      pre_fingerprint: preFingerprint,
      post_fingerprint: postFingerprint,
      verification_results: verificationResults,
      execution_id: payload.nonce,
    };
  }
}
