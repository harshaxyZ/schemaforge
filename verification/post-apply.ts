import { Pool } from 'pg';
import { captureFingerprint, SchemaFingerprint } from './schema-fingerprint';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes a single expected change that the migration should have applied.
 */
export interface ExpectedChange {
  type:
    | 'COLUMN_ADDED'
    | 'COLUMN_REMOVED'
    | 'COLUMN_MODIFIED'
    | 'CONSTRAINT_ADDED'
    | 'CONSTRAINT_REMOVED'
    | 'INDEX_ADDED';
  table: string;
  column?: string;
  constraint?: string;
  /** For COLUMN_MODIFIED: expected data_type, is_nullable, or column_default value. */
  expected_value?: string;
}

/**
 * Individual verification result for one expected change.
 */
export interface ChangeCheck {
  change: ExpectedChange;
  verified: boolean;
  actual_value?: string;
  error?: string;
}

/**
 * Aggregate post-apply verification report.
 */
export interface PostApplyReport {
  success: boolean;
  checks: ChangeCheck[];
  schema_fingerprint: SchemaFingerprint;
  verified_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TIMEOUT_PREFIX = 'SET LOCAL statement_timeout = 10000;';

/**
 * Verify that a column exists in information_schema.columns.
 */
async function verifyColumnExists(
  pool: Pool,
  table: string,
  column: string,
): Promise<ChangeCheck> {
  const change: ExpectedChange = { type: 'COLUMN_ADDED', table, column };
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, column],
    );
    const found = result.rows.length > 0;
    return {
      change,
      verified: found,
      actual_value: found ? column : undefined,
      error: found ? undefined : `Column ${column} not found on ${table}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { change, verified: false, error: message };
  }
}

/**
 * Verify that a column does NOT exist (for COLUMN_REMOVED).
 */
async function verifyColumnRemoved(
  pool: Pool,
  table: string,
  column: string,
): Promise<ChangeCheck> {
  const change: ExpectedChange = { type: 'COLUMN_REMOVED', table, column };
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, column],
    );
    const absent = result.rows.length === 0;
    return {
      change,
      verified: absent,
      actual_value: absent ? undefined : column,
      error: absent
        ? undefined
        : `Column ${column} still exists on ${table}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { change, verified: false, error: message };
  }
}

/**
 * Verify that a column has the expected data_type, is_nullable, or
 * column_default value.
 */
async function verifyColumnModified(
  pool: Pool,
  table: string,
  column: string,
  expectedValue?: string,
): Promise<ChangeCheck> {
  const change: ExpectedChange = {
    type: 'COLUMN_MODIFIED',
    table,
    column,
    expected_value: expectedValue,
  };
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, column],
    );

    if (result.rows.length === 0) {
      return {
        change,
        verified: false,
        error: `Column ${column} not found on ${table}`,
      };
    }

    const row = result.rows[0];
    const actual = `data_type=${row.data_type} is_nullable=${row.is_nullable} column_default=${row.column_default ?? 'NULL'}`;

    if (!expectedValue) {
      // No specific expected value — just confirm the column exists.
      return { change, verified: true, actual_value: actual };
    }

    // Check if the expected value appears anywhere in the actual summary.
    const verified = actual.includes(expectedValue);
    return {
      change,
      verified,
      actual_value: actual,
      error: verified
        ? undefined
        : `Expected "${expectedValue}" but got "${actual}"`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { change, verified: false, error: message };
  }
}

/**
 * Verify that a constraint exists in information_schema.table_constraints.
 */
async function verifyConstraintAdded(
  pool: Pool,
  table: string,
  constraintName: string,
): Promise<ChangeCheck> {
  const change: ExpectedChange = {
    type: 'CONSTRAINT_ADDED',
    table,
    constraint: constraintName,
  };
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT constraint_name, constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema   = 'public'
         AND table_name     = $1
         AND constraint_name = $2`,
      [table, constraintName],
    );
    const found = result.rows.length > 0;
    return {
      change,
      verified: found,
      actual_value: found ? result.rows[0].constraint_type : undefined,
      error: found
        ? undefined
        : `Constraint ${constraintName} not found on ${table}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { change, verified: false, error: message };
  }
}

/**
 * Verify that a constraint does NOT exist (for CONSTRAINT_REMOVED).
 */
async function verifyConstraintRemoved(
  pool: Pool,
  table: string,
  constraintName: string,
): Promise<ChangeCheck> {
  const change: ExpectedChange = {
    type: 'CONSTRAINT_REMOVED',
    table,
    constraint: constraintName,
  };
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema   = 'public'
         AND table_name     = $1
         AND constraint_name = $2`,
      [table, constraintName],
    );
    const absent = result.rows.length === 0;
    return {
      change,
      verified: absent,
      actual_value: absent ? undefined : constraintName,
      error: absent
        ? undefined
        : `Constraint ${constraintName} still exists on ${table}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { change, verified: false, error: message };
  }
}

/**
 * Verify that an index exists in pg_indexes.
 */
async function verifyIndexAdded(
  pool: Pool,
  table: string,
  indexName: string,
): Promise<ChangeCheck> {
  const change: ExpectedChange = {
    type: 'INDEX_ADDED',
    table,
    constraint: indexName,
  };
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename  = $1
         AND indexname   = $2`,
      [table, indexName],
    );
    const found = result.rows.length > 0;
    return {
      change,
      verified: found,
      actual_value: found ? result.rows[0].indexdef : undefined,
      error: found
        ? undefined
        : `Index ${indexName} not found on ${table}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { change, verified: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify that every expected migration change has been applied to the
 * database, then capture a fresh schema fingerprint.
 */
export async function verifyMigrationApplied(
  pool: Pool,
  expectedChanges: ExpectedChange[],
): Promise<PostApplyReport> {
  const checks: ChangeCheck[] = [];

  for (const ec of expectedChanges) {
    let check: ChangeCheck;

    switch (ec.type) {
      case 'COLUMN_ADDED':
        if (!ec.column) {
          check = {
            change: ec,
            verified: false,
            error: 'column field is required for COLUMN_ADDED',
          };
        } else {
          check = await verifyColumnExists(pool, ec.table, ec.column);
          check.change = ec; // preserve original
        }
        break;

      case 'COLUMN_REMOVED':
        if (!ec.column) {
          check = {
            change: ec,
            verified: false,
            error: 'column field is required for COLUMN_REMOVED',
          };
        } else {
          check = await verifyColumnRemoved(pool, ec.table, ec.column);
          check.change = ec;
        }
        break;

      case 'COLUMN_MODIFIED':
        if (!ec.column) {
          check = {
            change: ec,
            verified: false,
            error: 'column field is required for COLUMN_MODIFIED',
          };
        } else {
          check = await verifyColumnModified(
            pool,
            ec.table,
            ec.column,
            ec.expected_value,
          );
          check.change = ec;
        }
        break;

      case 'CONSTRAINT_ADDED':
        if (!ec.constraint) {
          check = {
            change: ec,
            verified: false,
            error: 'constraint field is required for CONSTRAINT_ADDED',
          };
        } else {
          check = await verifyConstraintAdded(pool, ec.table, ec.constraint);
          check.change = ec;
        }
        break;

      case 'CONSTRAINT_REMOVED':
        if (!ec.constraint) {
          check = {
            change: ec,
            verified: false,
            error: 'constraint field is required for CONSTRAINT_REMOVED',
          };
        } else {
          check = await verifyConstraintRemoved(pool, ec.table, ec.constraint);
          check.change = ec;
        }
        break;

      case 'INDEX_ADDED':
        if (!ec.constraint) {
          check = {
            change: ec,
            verified: false,
            error: 'constraint field is required for INDEX_ADDED (pass index name as constraint)',
          };
        } else {
          check = await verifyIndexAdded(pool, ec.table, ec.constraint);
          check.change = ec;
        }
        break;

      default:
        check = {
          change: ec,
          verified: false,
          error: `Unknown change type: ${(ec as ExpectedChange).type}`,
        };
    }

    checks.push(check);
  }

  // Capture fresh fingerprint after verification
  const schema_fingerprint = await captureFingerprint(pool);

  const success = checks.every((c) => c.verified);

  return {
    success,
    checks,
    schema_fingerprint,
    verified_at: new Date().toISOString(),
  };
}
