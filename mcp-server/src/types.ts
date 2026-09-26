/**
 * SchemaForge v2.0 — Core type definitions.
 *
 * These types form the contract between the MCP tool handlers,
 * the decision engine, and the human-approval boundary.
 */

// ─── Approval Gate ──────────────────────────────────────────────

/** A cryptographic approval token authorizing a single production mutation. */
export interface ApprovalToken {
  /** SHA-256 hash of the migration SQL, hex-encoded. */
  migration_hash: string;
  /** Target database identifier (e.g. "prod", "staging"). */
  target: string;
  /** Human-readable action description (e.g. "ALTER TABLE users ADD COLUMN email"). */
  action: string;
  /** ISO-8601 timestamp when the token was created. */
  created_at: string;
  /** ISO-8601 timestamp when the token expires. */
  expires_at: string;
  /** Whether this token can only be consumed once. */
  single_use: boolean;
  /** Whether this token has already been consumed. */
  used: boolean;
}

// ─── Schema Fingerprinting ──────────────────────────────────────

/** A point-in-time cryptographic fingerprint of the database schema. */
export interface SchemaFingerprint {
  /** SHA-256 hash of the canonical schema representation. */
  hash: string;
  /** ISO-8601 timestamp when the fingerprint was captured. */
  captured_at: string;
  /** Ordered list of table names included in the fingerprint. */
  tables: string[];
}

// ─── Decision Engine ────────────────────────────────────────────

/** Final migration verdict produced by the decision engine. */
export type MigrationDecision = 'APPLY' | 'REVIEW' | 'DO_NOT_APPLY';

/** Shadow rehearsal outcome. */
export type RehearsalResult = 'PASSED' | 'FAILED';

/** Rollback rehearsal verification status. */
export type RollbackResult = 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_APPLICABLE';

/** Schema drift detection result. */
export type SchemaDriftResult = 'NONE' | 'DETECTED';

/**
 * The complete decision packet presented to the human operator.
 * Contains all evidence the agent gathered plus its recommendation.
 */
export interface DecisionPacket {
  /** Target database identifier. */
  target: string;
  /** Natural-language description of the requested change. */
  requested_change: string;
  /** Number of rows inspected during impact analysis. */
  rows_inspected: number;
  /** Number of constraint / data violations found. */
  violations_found: number;
  /** Whether the forward migration succeeded on the shadow database. */
  shadow_rehearsal: RehearsalResult;
  /** Whether the rollback SQL was verified on the shadow database. */
  rollback_rehearsal: RollbackResult;
  /** Whether the production schema has drifted since inspection. */
  schema_drift: SchemaDriftResult;
  /** Number of application-level references flagged by dependency analysis. */
  application_refs_flagged: number;
  /** The agent's recommended decision. */
  decision: MigrationDecision;
  /** Ordered list of evidence items supporting the decision. */
  evidence: Evidence[];
}

/** A single piece of evidence gathered during migration analysis. */
export interface Evidence {
  /** Machine-readable name of the check (e.g. "null_ratio_check"). */
  check_name: string;
  /** Outcome of this check. */
  status: 'PASS' | 'FAIL' | 'WARNING';
  /** Human-readable explanation. */
  details: string;
  /** Optional measured value (e.g. "0.03%" or "42 rows"). */
  measured_value?: string;
  /** Whether the measured_value is an estimate vs. exact count. */
  is_estimate: boolean;
}

// ─── Safety Classification ──────────────────────────────────────

/**
 * Safety tier governing what the agent may do autonomously.
 *
 *  0 — Read-only inspection (no approval needed)
 *  1 — Shadow-only mutation (sandbox rehearsal)
 *  2 — Production mutation (requires ApprovalToken)
 *  3 — Prohibited operation (agent must refuse)
 */
export type SafetyTier = 0 | 1 | 2 | 3;

/**
 * How a migration should be executed.
 *
 *  TRANSACTIONAL     — Can be wrapped in BEGIN/COMMIT, safe to rollback.
 *  NON_TRANSACTIONAL — Cannot run inside a transaction (e.g. CREATE INDEX CONCURRENTLY).
 *  PROHIBITED        — Agent must refuse (e.g. DROP DATABASE).
 */
export type MigrationClassification = 'TRANSACTIONAL' | 'NON_TRANSACTIONAL' | 'PROHIBITED';
