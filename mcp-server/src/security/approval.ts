import crypto from 'node:crypto';
import type {
  ApprovalPayload,
  ApprovalRejectionCode,
  ApprovalToken,
  VerificationAssertion,
} from '../types.js';
import { normalizeMigrationSql } from './sql_policy.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ApprovalError extends Error {
  constructor(readonly code: ApprovalRejectionCode, message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export function hashMigrationSql(sql: string): string {
  return crypto.createHash('sha256').update(normalizeMigrationSql(sql), 'utf8').digest('hex');
}

function canonicalAssertions(assertions: VerificationAssertion[]): string {
  return JSON.stringify(
    assertions.map((assertion) => ({
      name: assertion.name,
      query: normalizeMigrationSql(assertion.query).replace(/;+\s*$/, ''),
      expectation: assertion.expectation,
      ...(assertion.expectation === 'scalar_equals'
        ? { expected_value: assertion.expected_value }
        : {}),
    })),
  );
}

export function hashVerificationAssertions(assertions: VerificationAssertion[]): string {
  return crypto.createHash('sha256').update(canonicalAssertions(assertions), 'utf8').digest('hex');
}

function canonicalPayload(payload: ApprovalPayload): string {
  return JSON.stringify({
    version: payload.version,
    nonce: payload.nonce,
    migration_hash: payload.migration_hash,
    assertions_hash: payload.assertions_hash,
    baseline_fingerprint: payload.baseline_fingerprint,
    expected_fingerprint: payload.expected_fingerprint,
    rehearsal_id: payload.rehearsal_id,
    target: payload.target,
    action: payload.action,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    single_use: payload.single_use,
  });
}

function computeSignature(payload: ApprovalPayload, secret: Buffer): Buffer {
  return crypto.createHmac('sha256', secret).update(canonicalPayload(payload), 'utf8').digest();
}

export function signApproval(payload: ApprovalPayload, secret: Buffer): ApprovalToken {
  return { payload, signature: computeSignature(payload, secret).toString('base64url') };
}

function malformed(message: string): never {
  throw new ApprovalError('TOKEN_MALFORMED', message);
}

export function verifyApproval(
  token: ApprovalToken,
  migrationSql: string,
  assertions: VerificationAssertion[],
  secret: Buffer,
  expectedTarget: string,
  maxTtlSeconds: number,
  now = new Date(),
): ApprovalPayload {
  const payload = token?.payload;
  if (!payload || typeof token.signature !== 'string') malformed('Approval token has an invalid shape.');
  if (payload.version !== 1 || payload.single_use !== true) malformed('Only version 1 single-use approvals are accepted.');
  if (!UUID_PATTERN.test(payload.nonce)) malformed('Approval nonce must be a UUID.');
  if (!HASH_PATTERN.test(payload.migration_hash) || !HASH_PATTERN.test(payload.assertions_hash)) {
    malformed('Migration and assertion hashes must be SHA-256 hex.');
  }
  if (!HASH_PATTERN.test(payload.baseline_fingerprint) || !HASH_PATTERN.test(payload.expected_fingerprint)) {
    malformed('Baseline and expected fingerprints must be SHA-256 hex.');
  }
  if (!payload.rehearsal_id || !payload.action || payload.action.length > 500) {
    malformed('Rehearsal ID and a concise action description are required.');
  }

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(token.signature, 'base64url');
  } catch {
    throw new ApprovalError('SIGNATURE_INVALID', 'Approval signature is not valid base64url.');
  }
  const expectedSignature = computeSignature(payload, secret);
  if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new ApprovalError('SIGNATURE_INVALID', 'Approval signature is invalid.');
  }

  const computedHash = Buffer.from(hashMigrationSql(migrationSql), 'hex');
  const approvedHash = Buffer.from(payload.migration_hash, 'hex');
  if (!crypto.timingSafeEqual(approvedHash, computedHash)) {
    throw new ApprovalError('HASH_MISMATCH', 'Migration SQL differs from the human-approved SQL.');
  }
  const assertionHash = Buffer.from(hashVerificationAssertions(assertions), 'hex');
  const approvedAssertionHash = Buffer.from(payload.assertions_hash, 'hex');
  if (!crypto.timingSafeEqual(approvedAssertionHash, assertionHash)) {
    throw new ApprovalError('ASSERTIONS_MISMATCH', 'Verification assertions differ from the human-approved set.');
  }
  if (payload.target !== expectedTarget) {
    throw new ApprovalError('TARGET_MISMATCH', `Approval target is ${payload.target}, expected ${expectedTarget}.`);
  }

  const issuedAt = Date.parse(payload.issued_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    malformed('Approval timestamps are invalid.');
  }
  const nowMs = now.getTime();
  if (issuedAt > nowMs + 30_000) throw new ApprovalError('TOKEN_NOT_YET_VALID', 'Approval issue time is in the future.');
  if (expiresAt <= nowMs) throw new ApprovalError('TOKEN_EXPIRED', `Approval expired at ${payload.expires_at}.`);
  if (expiresAt - issuedAt > maxTtlSeconds * 1_000) {
    throw new ApprovalError('TTL_EXCEEDED', `Approval TTL exceeds ${maxTtlSeconds} seconds.`);
  }

  return payload;
}

export function createApprovalPayload(input: {
  migrationSql: string;
  assertions: VerificationAssertion[];
  baselineFingerprint: string;
  expectedFingerprint: string;
  rehearsalId: string;
  action: string;
  ttlSeconds: number;
  target?: 'prod';
  now?: Date;
}): ApprovalPayload {
  const now = input.now ?? new Date();
  return {
    version: 1,
    nonce: crypto.randomUUID(),
    migration_hash: hashMigrationSql(input.migrationSql),
    assertions_hash: hashVerificationAssertions(input.assertions),
    baseline_fingerprint: input.baselineFingerprint.toLowerCase(),
    expected_fingerprint: input.expectedFingerprint.toLowerCase(),
    rehearsal_id: input.rehearsalId,
    target: input.target ?? 'prod',
    action: input.action,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
    single_use: true,
  };
}
