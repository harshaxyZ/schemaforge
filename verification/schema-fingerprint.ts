import { createHash } from 'crypto';
import { Pool } from 'pg';

/**
 * A point-in-time cryptographic fingerprint of a database schema.
 */
export interface SchemaFingerprint {
  /** SHA-256 hex digest of the deterministic schema representation. */
  hash: string;
  /** ISO-8601 timestamp when the fingerprint was captured. */
  captured_at: string;
  /** Sorted list of table names present in the schema. */
  tables: string[];
}

/**
 * Result of comparing two schema fingerprints.
 */
export interface FingerprintDiff {
  /** True if any structural change is detected. */
  drifted: boolean;
  /** Tables present in current but absent in previous. */
  added_tables: string[];
  /** Tables present in previous but absent in current. */
  removed_tables: string[];
  /** Whether the raw SHA-256 hashes are identical. */
  hash_match: boolean;
}

/**
 * Capture a deterministic SHA-256 fingerprint of the given schema.
 *
 * Queries information_schema for tables, columns, table_constraints, and
 * key_column_usage, then concatenates the results in sorted order so the
 * hash is reproducible across runs.
 */
export async function captureFingerprint(
  pool: Pool,
  schemaName: string = 'public',
): Promise<SchemaFingerprint> {
  const timeout = 'SET LOCAL statement_timeout = 10000';

  // --- 1. Tables ----------------------------------------------------------
  const tablesResult = await pool.query(
    `${timeout}; SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schemaName],
  );
  const tables: string[] = tablesResult.rows.map(
    (r: { table_name: string }) => r.table_name,
  );

  // --- 2. Columns ---------------------------------------------------------
  const columnsResult = await pool.query(
    `${timeout}; SELECT table_name, column_name, ordinal_position,
            data_type, character_maximum_length, numeric_precision,
            numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`,
    [schemaName],
  );

  // --- 3. Table constraints -----------------------------------------------
  const constraintsResult = await pool.query(
    `${timeout}; SELECT constraint_name, table_name, constraint_type
     FROM information_schema.table_constraints
     WHERE table_schema = $1
     ORDER BY table_name, constraint_name`,
    [schemaName],
  );

  // --- 4. Key column usage ------------------------------------------------
  const keyColResult = await pool.query(
    `${timeout}; SELECT constraint_name, table_name, column_name,
            ordinal_position
     FROM information_schema.key_column_usage
     WHERE table_schema = $1
     ORDER BY table_name, constraint_name, ordinal_position`,
    [schemaName],
  );

  // --- Build deterministic string ----------------------------------------
  const parts: string[] = [];

  // Tables section
  parts.push('TABLES:');
  for (const t of tables) {
    parts.push(`T|${t}`);
  }

  // Columns section
  parts.push('COLUMNS:');
  for (const c of columnsResult.rows) {
    parts.push(
      [
        'C',
        c.table_name,
        c.column_name,
        c.ordinal_position,
        c.data_type,
        c.character_maximum_length ?? '',
        c.numeric_precision ?? '',
        c.numeric_scale ?? '',
        c.is_nullable,
        c.column_default ?? '',
      ].join('|'),
    );
  }

  // Constraints section
  parts.push('CONSTRAINTS:');
  for (const con of constraintsResult.rows) {
    parts.push(
      ['CON', con.table_name, con.constraint_name, con.constraint_type].join(
        '|',
      ),
    );
  }

  // Key column usage section
  parts.push('KEY_COLUMNS:');
  for (const kc of keyColResult.rows) {
    parts.push(
      [
        'KC',
        kc.table_name,
        kc.constraint_name,
        kc.column_name,
        kc.ordinal_position,
      ].join('|'),
    );
  }

  const canonical = parts.join('\n');
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  return {
    hash,
    captured_at: new Date().toISOString(),
    tables,
  };
}

/**
 * Compare two schema fingerprints and report drift.
 */
export function compareFingerprints(
  current: SchemaFingerprint,
  previous: SchemaFingerprint,
): FingerprintDiff {
  const currentSet = new Set(current.tables);
  const previousSet = new Set(previous.tables);

  const added_tables = current.tables.filter((t) => !previousSet.has(t));
  const removed_tables = previous.tables.filter((t) => !currentSet.has(t));
  const hash_match = current.hash === previous.hash;

  return {
    drifted: !hash_match,
    added_tables,
    removed_tables,
    hash_match,
  };
}
