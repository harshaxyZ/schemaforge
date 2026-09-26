/** Shared contracts for SchemaForge's evidence and safety boundaries. */

// ─── Approval gate ──────────────────────────────────────────────

export interface ApprovalPayload {
  version: 1;
  nonce: string;
  migration_hash: string;
  assertions_hash: string;
  baseline_fingerprint: string;
  expected_fingerprint: string;
  rehearsal_id: string;
  target: 'prod';
  action: string;
  issued_at: string;
  expires_at: string;
  single_use: true;
}

export interface ApprovalToken {
  payload: ApprovalPayload;
  signature: string;
}

export type ApprovalRejectionCode =
  | 'TOKEN_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'HASH_MISMATCH'
  | 'ASSERTIONS_MISMATCH'
  | 'TARGET_MISMATCH'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_YET_VALID'
  | 'TTL_EXCEEDED'
  | 'REPLAY_DETECTED'
  | 'SCHEMA_DRIFT'
  | 'POSTCONDITION_FAILED';

// ─── Schema fingerprinting ──────────────────────────────────────

export interface SchemaFingerprint {
  hash: string;
  captured_at: string;
  tables: string[];
}

// ─── Verification ───────────────────────────────────────────────

export type JsonScalar = string | number | boolean | null;

type BaseVerificationAssertion = {
  name: string;
  query: string;
};

/** scalar_equals requires an explicit value; explicit null remains valid. */
export type VerificationAssertion =
  | (BaseVerificationAssertion & {
      expectation: 'returns_rows' | 'returns_no_rows' | 'first_value_true';
      expected_value?: never;
    })
  | (BaseVerificationAssertion & {
      expectation: 'scalar_equals';
      expected_value: JsonScalar;
    });

export interface VerificationAssertionResult {
  name: string;
  query: string;
  expectation: VerificationAssertion['expectation'];
  expected_value?: JsonScalar;
  actual_value?: JsonScalar;
  passed: boolean;
  row_count: number;
  rows: Record<string, unknown>[];
  error: string | null;
}

// ─── Decision evidence ──────────────────────────────────────────

export type MigrationDecision = 'APPLY' | 'REVIEW' | 'DO_NOT_APPLY';
export type RehearsalResult = 'PASSED' | 'FAILED';
export type RollbackResult = 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_APPLICABLE';
export type SchemaDriftResult = 'NONE' | 'DETECTED';

export interface Evidence {
  check_name: string;
  status: 'PASS' | 'FAIL' | 'WARNING';
  details: string;
  measured_value?: string;
  is_estimate: boolean;
}

export interface DecisionPacket {
  target: string;
  requested_change: string;
  rows_inspected: number;
  violations_found: number;
  shadow_rehearsal: RehearsalResult;
  rollback_rehearsal: RollbackResult;
  schema_drift: SchemaDriftResult;
  application_refs_flagged: number;
  decision: MigrationDecision;
  evidence: Evidence[];
}

// ─── SQL safety classification ──────────────────────────────────

export type SafetyTier = 0 | 1 | 2 | 3;
export type MigrationClassification =
  | 'TRANSACTIONAL'
  | 'NON_TRANSACTIONAL'
  | 'MIXED'
  | 'PROHIBITED'
  | 'UNSUPPORTED';

export interface SqlStatementAssessment {
  statement_number: number;
  classification: 'TRANSACTIONAL' | 'NON_TRANSACTIONAL' | 'PROHIBITED' | 'UNSUPPORTED';
  destructive: boolean;
  reason: string;
  preview: string;
}

export interface MigrationPolicyAssessment {
  classification: MigrationClassification;
  destructive: boolean;
  statements: SqlStatementAssessment[];
}
