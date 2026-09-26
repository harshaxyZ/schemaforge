/** Transaction-contained migration rehearsal against the isolated shadow database. */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { inspectSchemaWithClient } from './inspect_schema.js';
import { requireAtomicMigration } from '../security/sql_policy.js';
import { runAssertion } from '../verification.js';
import type {
  Evidence,
  MigrationDecision,
  MigrationPolicyAssessment,
  RehearsalResult,
  RollbackResult,
  SchemaFingerprint,
  VerificationAssertion,
  VerificationAssertionResult,
} from '../types.js';

export interface RehearseMigrationInput {
  forward_sql: string;
  rollback_sql?: string;
  verification_assertions: VerificationAssertion[];
}

export interface LockObservation {
  lock_type: string;
  mode: string;
  relation: string | null;
  granted: boolean;
  observed_ms_after_start: number;
}

export interface RehearseMigrationResult {
  rehearsal_id: string;
  shadow_rehearsal: RehearsalResult;
  rollback_rehearsal: RollbackResult;
  recommendation: MigrationDecision;
  policy: MigrationPolicyAssessment;
  baseline_fingerprint: SchemaFingerprint;
  post_fingerprint: SchemaFingerprint | null;
  rollback_fingerprint: SchemaFingerprint | null;
  forward_duration_ms: number;
  rollback_duration_ms: number | null;
  forward_error: string | null;
  rollback_error: string | null;
  verification_results: VerificationAssertionResult[];
  row_counts_before: Record<string, number>;
  row_counts_after: Record<string, number>;
  locks_observed: LockObservation[];
  notices: Array<{ severity: string; code: string | null; message: string }>;
  sandbox_rolled_back: true;
  evidence: Evidence[];
}

function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.SF_REHEARSAL_TIMEOUT_MS ?? '120000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

async function acquireRehearsalLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('schemaforge-shadow-rehearsal'))");
}

async function captureRowCounts(client: PoolClient): Promise<Record<string, number>> {
  const names = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname <> 'schemaforge_execution_ledger'
      ORDER BY c.relname`,
  );
  const counts: Record<string, number> = {};
  for (const { table_name } of names.rows) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM ${client.escapeIdentifier(table_name)}`,
    );
    counts[table_name] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

async function captureLocks(client: PoolClient, startedAt: number): Promise<LockObservation[]> {
  const result = await client.query<{
    lock_type: string;
    mode: string;
    relation: string | null;
    granted: boolean;
  }>(
    `SELECT locktype AS lock_type, mode,
            CASE WHEN relation IS NULL THEN NULL ELSE relation::regclass::text END AS relation,
            granted
       FROM pg_locks
      WHERE pid = pg_backend_pid() AND granted
      ORDER BY locktype, relation::regclass::text NULLS FIRST, mode`,
  );
  const observed = Math.round(performance.now() - startedAt);
  return result.rows.map((row) => ({ ...row, observed_ms_after_start: observed }));
}

async function assertionWithSavepoint(
  client: PoolClient,
  assertion: VerificationAssertion,
  index: number,
): Promise<VerificationAssertionResult> {
  const savepoint = `sf_assertion_${index}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await runAssertion(client, assertion);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return {
      name: assertion.name,
      query: assertion.query,
      expectation: assertion.expectation,
      ...(assertion.expected_value !== undefined ? { expected_value: assertion.expected_value } : {}),
      passed: false,
      row_count: 0,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function rehearseMigration(
  input: RehearseMigrationInput,
): Promise<RehearseMigrationResult> {
  const policy = requireAtomicMigration(input.forward_sql);
  if (input.rollback_sql) requireAtomicMigration(input.rollback_sql);
  if (input.verification_assertions.length === 0) {
    throw new Error('At least one machine-checkable verification assertion is required.');
  }

  const rehearsalId = crypto.randomUUID();
  const evidence: Evidence[] = [];

  const result = await db.withRollbackTransaction('shadow', async (client) => {
    const notices: RehearseMigrationResult['notices'] = [];
    const onNotice = (value: unknown): void => {
      const notice = value as { severity?: string; code?: string; message?: string };
      notices.push({
        severity: notice.severity ?? 'NOTICE',
        code: notice.code ?? null,
        message: notice.message ?? String(value),
      });
    };
    client.on('notice', onNotice);

    try {
      await acquireRehearsalLock(client);
      const baseline = await inspectSchemaWithClient(client);
      const rowCountsBefore = await captureRowCounts(client);
      let postFingerprint: SchemaFingerprint | null = null;
      let rollbackFingerprint: SchemaFingerprint | null = null;
      let forwardError: string | null = null;
      let rollbackError: string | null = null;
      let forwardSuccess = false;
      let rollbackResult: RollbackResult = 'NOT_APPLICABLE';
      let rollbackDurationMs: number | null = null;
      let rowCountsAfter: Record<string, number> = {};
      let locks: LockObservation[] = [];
      const verificationResults: VerificationAssertionResult[] = [];

      const forwardStartedAt = performance.now();
      await client.query('SAVEPOINT sf_forward');
      try {
        await client.query(input.forward_sql);
        await client.query('RELEASE SAVEPOINT sf_forward');
        forwardSuccess = true;
        postFingerprint = (await inspectSchemaWithClient(client)).fingerprint;
        rowCountsAfter = await captureRowCounts(client);
        locks = await captureLocks(client, forwardStartedAt);
      } catch (error) {
        forwardError = error instanceof Error ? error.message : String(error);
        await client.query('ROLLBACK TO SAVEPOINT sf_forward');
        await client.query('RELEASE SAVEPOINT sf_forward');
      }
      const forwardDurationMs = Math.round(performance.now() - forwardStartedAt);

      evidence.push({
        check_name: 'shadow_forward_apply',
        status: forwardSuccess ? 'PASS' : 'FAIL',
        details: forwardSuccess ? 'Forward SQL executed inside the rollback-only shadow transaction.' : `Forward SQL failed: ${forwardError}`,
        measured_value: `${forwardDurationMs}ms [OBSERVED]`,
        is_estimate: false,
      });

      if (forwardSuccess) {
        for (const [index, assertion] of input.verification_assertions.entries()) {
          const result = await assertionWithSavepoint(client, assertion, index);
          verificationResults.push(result);
          evidence.push({
            check_name: `assertion:${assertion.name}`,
            status: result.passed ? 'PASS' : 'FAIL',
            details: result.passed ? `Assertion "${assertion.name}" passed.` : `Assertion "${assertion.name}" failed${result.error ? `: ${result.error}` : '.'}`,
            measured_value: `${result.row_count} rows [OBSERVED]`,
            is_estimate: false,
          });
        }
      }

      if (forwardSuccess && input.rollback_sql) {
        const rollbackStartedAt = performance.now();
        await client.query('SAVEPOINT sf_rollback');
        try {
          await client.query(input.rollback_sql);
          rollbackFingerprint = (await inspectSchemaWithClient(client)).fingerprint;
          rollbackResult = rollbackFingerprint.hash === baseline.fingerprint.hash ? 'VERIFIED' : 'NOT_VERIFIED';
          if (rollbackResult === 'VERIFIED') {
            await client.query('RELEASE SAVEPOINT sf_rollback');
          } else {
            rollbackError = 'Rollback completed but did not restore the baseline schema fingerprint.';
            await client.query('ROLLBACK TO SAVEPOINT sf_rollback');
            await client.query('RELEASE SAVEPOINT sf_rollback');
          }
        } catch (error) {
          rollbackError = error instanceof Error ? error.message : String(error);
          rollbackResult = 'NOT_VERIFIED';
          await client.query('ROLLBACK TO SAVEPOINT sf_rollback');
          await client.query('RELEASE SAVEPOINT sf_rollback');
        }
        rollbackDurationMs = Math.round(performance.now() - rollbackStartedAt);
        evidence.push({
          check_name: 'shadow_rollback_verify',
          status: rollbackResult === 'VERIFIED' ? 'PASS' : 'FAIL',
          details: rollbackResult === 'VERIFIED' ? 'Rollback restored the exact baseline schema fingerprint.' : `Rollback was not verified: ${rollbackError}`,
          measured_value: `${rollbackDurationMs}ms [OBSERVED]`,
          is_estimate: false,
        });
      } else if (!input.rollback_sql) {
        evidence.push({
          check_name: 'shadow_rollback_verify',
          status: 'WARNING',
          details: 'No rollback SQL was supplied; human review is required.',
          is_estimate: false,
        });
      }

      const assertionsPassed =
        verificationResults.length === input.verification_assertions.length &&
        verificationResults.every((result) => result.passed);
      const shadowRehearsal: RehearsalResult = forwardSuccess && assertionsPassed ? 'PASSED' : 'FAILED';
      const recommendation: MigrationDecision =
        shadowRehearsal === 'FAILED' || rollbackResult === 'NOT_VERIFIED'
          ? 'DO_NOT_APPLY'
          : rollbackResult !== 'VERIFIED' || policy.destructive
            ? 'REVIEW'
            : 'APPLY';

      return {
        rehearsal_id: rehearsalId,
        shadow_rehearsal: shadowRehearsal,
        rollback_rehearsal: rollbackResult,
        recommendation,
        policy,
        baseline_fingerprint: baseline.fingerprint,
        post_fingerprint: postFingerprint,
        rollback_fingerprint: rollbackFingerprint,
        forward_duration_ms: forwardDurationMs,
        rollback_duration_ms: rollbackDurationMs,
        forward_error: forwardError,
        rollback_error: rollbackError,
        verification_results: verificationResults,
        row_counts_before: rowCountsBefore,
        row_counts_after: rowCountsAfter,
        locks_observed: locks,
        notices,
        evidence,
      };
    } finally {
      client.removeListener('notice', onNotice);
    }
  }, {
    statementTimeoutMs: timeoutMs(),
    lockTimeoutMs: 3_000,
    isolationLevel: 'REPEATABLE READ',
  });

  return { ...result, sandbox_rolled_back: true };
}
