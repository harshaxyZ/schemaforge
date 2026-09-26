/**
 * DB-backed black-box scenarios over real MCP HTTP (core :3200, executor :3201).
 * Order matters and is sequential: A (no prod change) -> prohibited SQL -> read-only tricks
 * -> approval rejections (incl. drift) -> B applies -> replay -> cleanup through the executor.
 * Skipped automatically when the databases are unreachable (set SF_E2E_REQUIRE_DB=1 to fail).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createApprovalPayload, signApproval } from '../../../mcp-server/src/security/approval.js';
import type { ApprovalToken, VerificationAssertion } from '../../../mcp-server/src/types.js';
import { adminQuery } from '../../support/db.js';
import { cliEnv, readEnv, TMP_DIR } from '../../support/env.js';
import { call, connect, type Json } from '../../support/mcp.js';
import { runToExit } from '../../support/process.js';
import { ARCHIVED_AT_EXISTS, SCENARIO_A, SCENARIO_B, seededNullEmailCount } from '../../support/scenario.js';

const env = readEnv();
const dbAvailable = env.E2E_DB_AVAILABLE === '1';
const DRIFT_INDEX = 'e2e_drift_probe_idx';

let core: Client;
let executor: Client;

async function prodFingerprint(): Promise<string> {
  const result = await call(core, 'db_inspect_schema', {});
  expect(result.isError, JSON.stringify(result.data)).toBe(false);
  return result.data.fingerprint.hash as string;
}

async function scalar(query: string): Promise<unknown> {
  const result = await call(core, 'db_run_readonly_query', { query });
  expect(result.isError, JSON.stringify(result.data)).toBe(false);
  const row = result.data.rows[0] as Json;
  return row[Object.keys(row)[0]];
}

/** Mint a token through the real human-side CLI (`approve.ts --confirm`). */
async function mintViaCli(sql: string, assertions: VerificationAssertion[], baseline: string, expected: string, rehearsalId: string, action: string): Promise<ApprovalToken> {
  mkdirSync(TMP_DIR, { recursive: true });
  const sqlFile = path.join(TMP_DIR, `migration-${crypto.randomUUID()}.sql`);
  const assertionsFile = sqlFile.replace(/\.sql$/, '.assertions.json');
  writeFileSync(sqlFile, sql);
  writeFileSync(assertionsFile, JSON.stringify(assertions));
  const result = await runToExit(
    path.join('cli', 'approve.ts'),
    ['--sql-file', sqlFile, '--assertions-file', assertionsFile, '--baseline', baseline, '--expected', expected, '--rehearsal-id', rehearsalId, '--action', action, '--confirm'],
    cliEnv(env),
  );
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ApprovalToken;
}

async function execute(sql: string, token: ApprovalToken, assertions: VerificationAssertion[] = SCENARIO_B.verification_assertions): Promise<Json> {
  const result = await call(executor, 'execute_migration', {
    migration_sql: sql,
    verification_assertions: assertions,
    approval_token: token,
  });
  return result.data;
}

/** Remove e2e-only artifacts left behind by an interrupted earlier run. */
async function healLeftovers(): Promise<void> {
  await adminQuery(env.E2E_PROD_ADMIN_URL, `DROP INDEX IF EXISTS public.${DRIFT_INDEX}`);
  const exists = await adminQuery(env.E2E_PROD_ADMIN_URL, ARCHIVED_AT_EXISTS);
  if (exists.rows[0].count > 0) {
    console.warn('[e2e] users.archived_at left over from an earlier run; removing via admin URL.');
    await adminQuery(env.E2E_PROD_ADMIN_URL, 'ALTER TABLE users DROP COLUMN IF EXISTS archived_at');
  }
}

describe.skipIf(!dbAvailable)('SchemaForge scenarios against real PostgreSQL', () => {
  let originalFingerprint = '';

  beforeAll(async () => {
    core = await connect(env.E2E_CORE_PORT, 'scenario-core');
    executor = await connect(env.E2E_EXECUTOR_PORT, 'scenario-executor');
    await healLeftovers();
    originalFingerprint = await prodFingerprint();
  });

  afterAll(async () => {
    // Last-resort safety net; the happy path cleans up through the executor itself.
    await healLeftovers().catch((error) => console.error('[e2e] cleanup failed', error));
    await core?.close();
    await executor?.close();
  });

  describe('Rule: evidence before action — Scenario A "make users.email NOT NULL"', () => {
    it(`production holds exactly the seeded NULL emails (${seededNullEmailCount()})`, async () => {
      expect(Number(await scalar('SELECT count(*)::int AS n FROM users WHERE email IS NULL'))).toBe(seededNullEmailCount());
    });

    it('shadow rehearsal fails on the NULL rows and the decision is DO_NOT_APPLY', async () => {
      const result = await call(core, 'rehearse_migration', SCENARIO_A);
      expect(result.isError, JSON.stringify(result.data)).toBe(false);
      expect(result.data).toMatchObject({
        shadow_rehearsal: 'FAILED',
        recommendation: 'DO_NOT_APPLY',
        sandbox_rolled_back: true,
      });
      expect(result.data.forward_error).toMatch(/null values/i);
      expect(result.data.post_fingerprint).toBeNull();
    });

    it('production schema fingerprint is unchanged after the rehearsal', async () => {
      expect(await prodFingerprint()).toBe(originalFingerprint);
    });
  });

  describe('Rule: prohibited SQL is refused before it reaches any database', () => {
    it.each([['DROP TABLE orders;'], ['TRUNCATE users;'], ['GRANT ALL ON users TO PUBLIC;']])(
      'rehearse_migration refuses %s with PROHIBITED_SQL',
      async (sql) => {
        const result = await call(core, 'rehearse_migration', {
          forward_sql: sql,
          verification_assertions: SCENARIO_A.verification_assertions,
        });
        expect(result.isError).toBe(true);
        expect(result.data.error.code).toBe('PROHIBITED_SQL');
      },
    );

    it('execute_migration refuses DROP TABLE with SQL_POLICY_REJECTED even with a signed token', async () => {
      const sql = 'DROP TABLE orders;';
      const token = await mintViaCli(sql, SCENARIO_B.verification_assertions, originalFingerprint, originalFingerprint, crypto.randomUUID(), 'e2e prohibited probe');
      const data = await execute(sql, token);
      expect(data).toMatchObject({ success: false, executed: false, error_code: 'SQL_POLICY_REJECTED' });
      expect(Number(await scalar("SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'orders'"))).toBe(1);
    });
  });

  describe('Rule: the model-facing read tool cannot write production', () => {
    it.each([
      ['stacked statement', 'SELECT 1; DELETE FROM order_items WHERE id = 1'],
      ['data-modifying CTE', 'WITH gone AS (DELETE FROM order_items WHERE id = 1 RETURNING *) SELECT * FROM gone'],
      ['UPDATE CTE', 'WITH up AS (UPDATE users SET name = name WHERE id = 1 RETURNING id) SELECT * FROM up'],
      ['row locking read', 'SELECT id FROM users FOR UPDATE'],
      ['bare DELETE', 'DELETE FROM order_items WHERE id = 1'],
    ])('rejects a %s', async (_label, query) => {
      const before = Number(await scalar('SELECT count(*)::int FROM order_items'));
      const result = await call(core, 'db_run_readonly_query', { query });
      expect(result.isError).toBe(true);
      expect(Number(await scalar('SELECT count(*)::int FROM order_items'))).toBe(before);
    });

    it('rejects a dollar-identifier smuggled COMMIT + DELETE (policy regression, sf_reader backstop)', async () => {
      const before = Number(await scalar('SELECT count(*)::int FROM order_items'));
      const query = 'SELECT 1 AS a$q$) s; COMMIT; DELETE FROM order_items WHERE id = 1; SELECT 1 AS b$q$ FROM (SELECT 1';
      const result = await call(core, 'db_run_readonly_query', { query });
      expect(result.isError).toBe(true);
      expect(Number(await scalar('SELECT count(*)::int FROM order_items'))).toBe(before);
    });
  });

  describe('Rule: human-gated execution — Scenario B "add nullable users.archived_at"', () => {
    let rehearsal: Json;
    let token: ApprovalToken;
    const codes: string[] = [];

    it('shadow rehearsal passes with verified rollback and recommends APPLY', async () => {
      const result = await call(core, 'rehearse_migration', SCENARIO_B);
      expect(result.isError, JSON.stringify(result.data)).toBe(false);
      rehearsal = result.data;
      expect(rehearsal).toMatchObject({ shadow_rehearsal: 'PASSED', rollback_rehearsal: 'VERIFIED', recommendation: 'APPLY' });
      // The shadow baseline must equal production, or the executor could never accept it.
      expect(rehearsal.baseline_fingerprint.hash).toBe(originalFingerprint);
      expect(rehearsal.post_fingerprint.hash).not.toBe(originalFingerprint);
      expect(await prodFingerprint()).toBe(originalFingerprint);
    });

    it('the approval CLI refuses to mint without --confirm', async () => {
      const result = await runToExit(path.join('cli', 'approve.ts'), ['--sql-file', 'x.sql'], cliEnv(env));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Approval not confirmed/);
    });

    it('a human mints an exact-action token through the real CLI', async () => {
      token = await mintViaCli(SCENARIO_B.forward_sql, SCENARIO_B.verification_assertions, rehearsal.baseline_fingerprint.hash, rehearsal.post_fingerprint.hash, rehearsal.rehearsal_id, 'Add nullable users.archived_at');
      expect(token.payload).toMatchObject({ version: 1, target: 'prod', single_use: true, rehearsal_id: rehearsal.rehearsal_id });
    });

    it('rejects a forged signature (SIGNATURE_INVALID)', async () => {
      const forged = { ...token, signature: crypto.createHmac('sha256', crypto.randomBytes(48)).update('forged').digest('base64url') };
      const data = await execute(SCENARIO_B.forward_sql, forged);
      expect(data).toMatchObject({ success: false, executed: false, error_code: 'SIGNATURE_INVALID' });
      codes.push(data.error_code);
    });

    it('rejects edited SQL under a genuine token (HASH_MISMATCH)', async () => {
      const edited = 'ALTER TABLE users ADD COLUMN archived_at TIMESTAMPTZ; ALTER TABLE users ADD COLUMN is_admin BOOLEAN;';
      const data = await execute(edited, token);
      expect(data).toMatchObject({ success: false, executed: false, error_code: 'HASH_MISMATCH' });
      codes.push(data.error_code);
    });

    it('rejects a weakened assertion set under a genuine token (ASSERTIONS_MISMATCH)', async () => {
      const weaker: VerificationAssertion[] = [{ name: 'always true', query: 'SELECT true', expectation: 'first_value_true' }];
      const data = await execute(SCENARIO_B.forward_sql, token, weaker);
      expect(data).toMatchObject({ success: false, executed: false, error_code: 'ASSERTIONS_MISMATCH' });
      codes.push(data.error_code);
    });

    it('rejects an expired token (TOKEN_EXPIRED)', async () => {
      const expired = signApproval(
        createApprovalPayload({
          migrationSql: SCENARIO_B.forward_sql,
          assertions: SCENARIO_B.verification_assertions,
          baselineFingerprint: rehearsal.baseline_fingerprint.hash,
          expectedFingerprint: rehearsal.post_fingerprint.hash,
          rehearsalId: rehearsal.rehearsal_id,
          action: 'expired e2e token',
          ttlSeconds: 60,
          now: new Date(Date.now() - 10 * 60_000),
        }),
        Buffer.from(env.SF_APPROVAL_SECRET, 'utf8'),
      );
      const data = await execute(SCENARIO_B.forward_sql, expired);
      expect(data).toMatchObject({ success: false, executed: false, error_code: 'TOKEN_EXPIRED' });
      codes.push(data.error_code);
    });

    it('rejects production schema drift between approval and apply (SCHEMA_DRIFT)', async () => {
      // A separate token for the same SQL; drift is introduced out-of-band by an admin.
      const driftToken = await mintViaCli(SCENARIO_B.forward_sql, SCENARIO_B.verification_assertions, rehearsal.baseline_fingerprint.hash, rehearsal.post_fingerprint.hash, rehearsal.rehearsal_id, 'drift probe');
      await adminQuery(env.E2E_PROD_ADMIN_URL, `CREATE INDEX ${DRIFT_INDEX} ON products (stock)`);
      try {
        const data = await execute(SCENARIO_B.forward_sql, driftToken);
        expect(data).toMatchObject({ success: false, error_code: 'SCHEMA_DRIFT' });
        codes.push(data.error_code);
        expect(Number(await scalar(ARCHIVED_AT_EXISTS))).toBe(0);
      } finally {
        await adminQuery(env.E2E_PROD_ADMIN_URL, `DROP INDEX IF EXISTS public.${DRIFT_INDEX}`);
      }
      expect(await prodFingerprint()).toBe(originalFingerprint);
    });

    it('applies the approved migration and verify_production confirms the column', async () => {
      const data = await execute(SCENARIO_B.forward_sql, token);
      expect(data, JSON.stringify(data)).toMatchObject({ success: true, executed: true, error_code: null, execution_id: token.payload.nonce });
      expect(data.post_fingerprint.hash).toBe(rehearsal.post_fingerprint.hash);

      const verified = await call(core, 'verify_production', {
        expected_fingerprint: rehearsal.post_fingerprint.hash,
        verification_assertions: SCENARIO_B.verification_assertions,
      });
      expect(verified.isError, JSON.stringify(verified.data)).toBe(false);
      expect(verified.data).toMatchObject({ fingerprint_matches: true, all_checks_passed: true });
    });

    it('rejects a replay of the consumed token (REPLAY_DETECTED)', async () => {
      const data = await execute(SCENARIO_B.forward_sql, token);
      expect(data).toMatchObject({ success: false, executed: false, error_code: 'REPLAY_DETECTED' });
      codes.push(data.error_code);
    });

    it('every rejection class carries a distinct machine-readable code', () => {
      expect(codes).toHaveLength(6);
      expect(new Set(codes).size).toBe(6);
    });

    it('cleanup: rolls B back through the same human-gated executor path', async () => {
      const rollback = SCENARIO_B.rollback_sql;
      const gone: VerificationAssertion[] = [
        { name: 'users.archived_at removed', query: ARCHIVED_AT_EXISTS, expectation: 'scalar_equals', expected_value: 0 },
      ];
      const cleanupToken = await mintViaCli(rollback, gone, rehearsal.post_fingerprint.hash, originalFingerprint, `${rehearsal.rehearsal_id}-rollback`, 'e2e cleanup: drop users.archived_at');
      const data = await execute(rollback, cleanupToken, gone);
      expect(data, JSON.stringify(data)).toMatchObject({ success: true, executed: true });
      expect(await prodFingerprint()).toBe(originalFingerprint);
    });
  });
});
