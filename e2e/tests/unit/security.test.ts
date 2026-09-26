/**
 * In-process unit tests of the security primitives (no DB, no HTTP).
 * Imports Kiro's source read-only; nothing is written into mcp-server/.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { loadConfig } from '../../../mcp-server/src/config.js';
import {
  ApprovalError,
  createApprovalPayload,
  signApproval,
  verifyApproval,
} from '../../../mcp-server/src/security/approval.js';
import {
  assessMigration,
  requireAtomicMigration,
  requireReadonlyQuery,
} from '../../../mcp-server/src/security/sql_policy.js';
import type { VerificationAssertion } from '../../../mcp-server/src/types.js';

const SECRET = Buffer.from(crypto.randomBytes(48).toString('base64url'));
const HEX = 'a'.repeat(64);
const SQL = 'ALTER TABLE users ADD COLUMN archived_at TIMESTAMPTZ;';
const ASSERTIONS: VerificationAssertion[] = [
  { name: 'archived_at exists', query: "SELECT 1 FROM information_schema.columns WHERE column_name = 'archived_at'", expectation: 'returns_rows' },
];

function token(overrides: { now?: Date; ttlSeconds?: number; sql?: string } = {}) {
  return signApproval(
    createApprovalPayload({
      migrationSql: overrides.sql ?? SQL,
      assertions: ASSERTIONS,
      baselineFingerprint: HEX,
      expectedFingerprint: 'b'.repeat(64),
      rehearsalId: crypto.randomUUID(),
      action: 'unit test',
      ttlSeconds: overrides.ttlSeconds ?? 300,
      now: overrides.now,
    }),
    SECRET,
  );
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof ApprovalError ? error.code : `NOT_APPROVAL_ERROR:${String(error)}`;
  }
  return 'ACCEPTED';
}

describe('Rule: human approval is an exact-action, short-lived HMAC token', () => {
  it('accepts a genuine token for the exact SQL (CRLF/whitespace transport noise tolerated)', () => {
    const t = token();
    expect(codeOf(() => verifyApproval(t, `\r\n${SQL.replace(/\n/g, '\r\n')}  `, ASSERTIONS, SECRET, 'prod', 300))).toBe('ACCEPTED');
  });

  it('rejects a forged signature with SIGNATURE_INVALID', () => {
    const t = token();
    const forged = { ...t, signature: crypto.createHmac('sha256', 'attacker-guess-'.repeat(3)).update('x').digest('base64url') };
    expect(codeOf(() => verifyApproval(forged, SQL, ASSERTIONS, SECRET, 'prod', 300))).toBe('SIGNATURE_INVALID');
  });

  it('rejects a tampered payload with SIGNATURE_INVALID', () => {
    const t = token();
    const tampered = { ...t, payload: { ...t.payload, action: 'something else' } };
    expect(codeOf(() => verifyApproval(tampered, SQL, ASSERTIONS, SECRET, 'prod', 300))).toBe('SIGNATURE_INVALID');
  });

  it('rejects edited SQL with HASH_MISMATCH', () => {
    expect(codeOf(() => verifyApproval(token(), `${SQL} ALTER TABLE users DROP COLUMN name;`, ASSERTIONS, SECRET, 'prod', 300))).toBe('HASH_MISMATCH');
  });

  it('rejects a swapped assertion set with ASSERTIONS_MISMATCH', () => {
    const weaker: VerificationAssertion[] = [{ name: 'always true', query: 'SELECT true', expectation: 'first_value_true' }];
    expect(codeOf(() => verifyApproval(token(), SQL, weaker, SECRET, 'prod', 300))).toBe('ASSERTIONS_MISMATCH');
  });

  it('rejects an expired token with TOKEN_EXPIRED', () => {
    const t = token({ now: new Date(Date.now() - 10 * 60_000), ttlSeconds: 60 });
    expect(codeOf(() => verifyApproval(t, SQL, ASSERTIONS, SECRET, 'prod', 300))).toBe('TOKEN_EXPIRED');
  });

  it('rejects a token whose TTL exceeds policy with TTL_EXCEEDED', () => {
    expect(codeOf(() => verifyApproval(token({ ttlSeconds: 3_600 }), SQL, ASSERTIONS, SECRET, 'prod', 300))).toBe('TTL_EXCEEDED');
  });

  it('rejects a future-dated token with TOKEN_NOT_YET_VALID', () => {
    const t = token({ now: new Date(Date.now() + 5 * 60_000) });
    expect(codeOf(() => verifyApproval(t, SQL, ASSERTIONS, SECRET, 'prod', 600))).toBe('TOKEN_NOT_YET_VALID');
  });
});

describe('Rule: prohibited SQL never reaches a database', () => {
  it.each([
    ['DROP TABLE users;'],
    ['TRUNCATE orders;'],
    ['GRANT ALL ON users TO PUBLIC;'],
    ['ALTER TABLE users ADD COLUMN x int; DROP TABLE orders;'],
  ])('classifies %s as PROHIBITED', (sql) => {
    expect(assessMigration(sql).classification).toBe('PROHIBITED');
    expect(() => requireAtomicMigration(sql)).toThrow();
  });

  it.each([['DELETE FROM users WHERE id = 1;'], ['UPDATE users SET name = NULL WHERE id = 1;'], ['COMMENT ON TABLE users IS NULL;']])(
    'fails closed on non-DDL %s (UNSUPPORTED)',
    (sql) => {
      expect(assessMigration(sql).classification).toBe('UNSUPPORTED');
      expect(() => requireAtomicMigration(sql)).toThrow();
    },
  );

  it('refuses any migration that references the internal execution ledger', () => {
    expect(() => assessMigration('ALTER TABLE schemaforge_execution_ledger ADD COLUMN x int;')).toThrow(/ledger/);
  });

  it('ignores keywords hidden inside string literals and comments', () => {
    expect(assessMigration("ALTER TABLE users ADD COLUMN note text DEFAULT 'never DROP TABLE users'; -- TRUNCATE").classification).toBe('TRANSACTIONAL');
  });

  it('dollar-sign identifiers do not hide DROP TABLE from the migration policy', () => {
    const sql = 'ALTER TABLE users ADD COLUMN a$q$ int; DROP TABLE orders CASCADE; ALTER TABLE users ADD COLUMN b$q$ int;';
    expect(assessMigration(sql).classification).toBe('PROHIBITED');
  });

  it('dollar-sign identifiers cannot smuggle COMMIT + DELETE past read-only policy', () => {
    const sql = 'SELECT 1 AS a$q$) s; COMMIT; DELETE FROM users WHERE id = 7; SELECT 1 AS b$q$ FROM (SELECT 1';
    expect(() => requireReadonlyQuery(sql)).toThrow();
  });
});

describe('Rule: db_run_readonly_query policy admits only one side-effect-free read', () => {
  it.each([
    ['SELECT 1; DELETE FROM users WHERE id = 1'],
    ['WITH gone AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM gone'],
    ['WITH up AS (UPDATE users SET name = name WHERE id = 1 RETURNING *) SELECT * FROM up'],
    ['WITH ins AS (INSERT INTO users (email) VALUES (null) RETURNING *) SELECT * FROM ins'],
    ['SELECT * FROM users FOR UPDATE'],
    ['SELECT * INTO TEMP TABLE t FROM users'],
    ['SELECT pg_sleep(60)'],
    ['DELETE FROM users WHERE id = 1'],
  ])('rejects %s', (sql) => {
    expect(() => requireReadonlyQuery(sql)).toThrow();
  });

  it('accepts a plain SELECT and a read-only CTE', () => {
    expect(requireReadonlyQuery('SELECT count(*) FROM users;')).toBe('SELECT count(*) FROM users');
    expect(() => requireReadonlyQuery('WITH n AS (SELECT 1 AS v) SELECT v FROM n')).not.toThrow();
  });
});

describe('Rule: least-privilege process separation is enforced at config load', () => {
  const base = {
    SF_PROD_READONLY_URL: 'postgresql://r:r@127.0.0.1:5433/p',
    SF_SHADOW_URL: 'postgresql://s:s@127.0.0.1:5434/s',
  };

  it('core refuses SF_PROD_WRITE_URL', () => {
    expect(() => loadConfig('core', { ...base, SF_PROD_WRITE_URL: 'postgresql://w:w@127.0.0.1:5433/p' })).toThrow(/Refusing to start core/);
  });

  it('core refuses SF_APPROVAL_SECRET', () => {
    expect(() => loadConfig('core', { ...base, SF_APPROVAL_SECRET: SECRET.toString() })).toThrow(/Refusing to start core/);
  });

  it('refuses a non-loopback bind without SF_MCP_API_KEY, allows it with one', () => {
    expect(() => loadConfig('core', { ...base, SF_HTTP_HOST: '0.0.0.0' })).toThrow(/SF_MCP_API_KEY is required/);
    expect(() => loadConfig('core', { ...base, SF_HTTP_HOST: '0.0.0.0', SF_MCP_API_KEY: 'k'.repeat(32) })).not.toThrow();
  });

  it('rejects the example placeholder and short approval secrets', () => {
    const exec = {
      SF_PROD_READONLY_URL: base.SF_PROD_READONLY_URL,
      SF_PROD_WRITE_URL: 'postgresql://w:w@127.0.0.1:5433/p',
    };
    expect(() => loadConfig('executor', { ...exec, SF_APPROVAL_SECRET: 'replace-with-a-cryptographically-random-secret-of-at-least-32-characters' })).toThrow(/placeholder/);
    expect(() => loadConfig('executor', { ...exec, SF_APPROVAL_SECRET: 'too-short' })).toThrow(/at least 32/);
  });
});
