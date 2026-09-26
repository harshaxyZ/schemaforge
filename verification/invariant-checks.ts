import { Pool } from 'pg';

/**
 * Aggregate invariant report for a single table.
 */
export interface InvariantReport {
  table: string;
  row_count: number;
  null_violations: number;
  fk_violations: Array<{ constraint_name: string; count: number }>;
  unique_violations: number;
  constraints_valid: boolean;
  checked_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Quote a SQL identifier to prevent injection when parameterized queries
 * cannot be used (e.g. table / column names in dynamic SQL).
 *
 * Doubles any embedded double-quotes and wraps the name.
 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Prefix every query with a 10-second statement timeout. */
const TIMEOUT_PREFIX = 'SET LOCAL statement_timeout = 10000;';

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Count rows where a NOT NULL column is actually NULL.
 * Returns the count and a sample of up to 5 primary-key values.
 */
export async function checkNotNullViolations(
  pool: Pool,
  tableName: string,
  columnName: string,
): Promise<{ count: number; sample_ids: number[] }> {
  try {
    const tbl = quoteIdent(tableName);
    const col = quoteIdent(columnName);

    const countResult = await pool.query(
      `${TIMEOUT_PREFIX} SELECT count(*)::int AS cnt FROM ${tbl} WHERE ${col} IS NULL`,
    );
    const count: number = countResult.rows[0]?.cnt ?? 0;

    let sample_ids: number[] = [];
    if (count > 0) {
      // Try to fetch the PK column name for samples.
      const pkResult = await pool.query(
        `${TIMEOUT_PREFIX}
         SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema   = kcu.table_schema
         WHERE tc.table_name = $1
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position
         LIMIT 1`,
        [tableName],
      );

      if (pkResult.rows.length > 0) {
        const pkCol = quoteIdent(pkResult.rows[0].column_name);
        const sampleResult = await pool.query(
          `${TIMEOUT_PREFIX} SELECT ${pkCol}::int AS id FROM ${tbl} WHERE ${col} IS NULL LIMIT 5`,
        );
        sample_ids = sampleResult.rows.map((r: { id: number }) => r.id);
      }
    }

    return { count, sample_ids };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `checkNotNullViolations(${tableName}.${columnName}): ${message}`,
    );
  }
}

/**
 * Validate foreign-key integrity by checking pg_constraint for NOT VALID
 * constraints and then probing for actual orphan rows.
 */
export async function checkForeignKeyIntegrity(
  pool: Pool,
  tableName: string,
): Promise<{ violations: Array<{ constraint_name: string; count: number }> }> {
  try {
    const fkResult = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT con.conname       AS constraint_name,
              con.convalidated  AS is_valid,
              att_src.attname   AS src_column,
              cls_ref.relname   AS ref_table,
              att_ref.attname   AS ref_column
       FROM pg_constraint con
       JOIN pg_class cls       ON cls.oid = con.conrelid
       JOIN pg_namespace nsp   ON nsp.oid = cls.relnamespace
       JOIN pg_attribute att_src ON att_src.attrelid = con.conrelid
                                AND att_src.attnum   = ANY(con.conkey)
       JOIN pg_class cls_ref   ON cls_ref.oid = con.confrelid
       JOIN pg_attribute att_ref ON att_ref.attrelid = con.confrelid
                                AND att_ref.attnum   = ANY(con.confkey)
       WHERE cls.relname  = $1
         AND nsp.nspname  = 'public'
         AND con.contype  = 'f'
       ORDER BY con.conname`,
      [tableName],
    );

    const violations: Array<{ constraint_name: string; count: number }> = [];

    for (const fk of fkResult.rows) {
      const srcTbl = quoteIdent(tableName);
      const srcCol = quoteIdent(fk.src_column);
      const refTbl = quoteIdent(fk.ref_table);
      const refCol = quoteIdent(fk.ref_column);

      const orphanResult = await pool.query(
        `${TIMEOUT_PREFIX}
         SELECT count(*)::int AS cnt
         FROM ${srcTbl} s
         LEFT JOIN ${refTbl} r ON s.${srcCol} = r.${refCol}
         WHERE s.${srcCol} IS NOT NULL
           AND r.${refCol} IS NULL`,
      );

      const cnt: number = orphanResult.rows[0]?.cnt ?? 0;
      if (cnt > 0) {
        violations.push({ constraint_name: fk.constraint_name, count: cnt });
      }
    }

    return { violations };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `checkForeignKeyIntegrity(${tableName}): ${message}`,
    );
  }
}

/**
 * Find duplicate values in a column that is expected to be unique.
 */
export async function checkUniqueViolations(
  pool: Pool,
  tableName: string,
  columnName: string,
): Promise<{ duplicate_count: number; sample_values: string[] }> {
  try {
    const tbl = quoteIdent(tableName);
    const col = quoteIdent(columnName);

    const dupResult = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT ${col}::text AS val, count(*)::int AS cnt
       FROM ${tbl}
       GROUP BY ${col}
       HAVING count(*) > 1
       ORDER BY cnt DESC
       LIMIT 10`,
    );

    const duplicate_count: number = dupResult.rows.reduce(
      (sum: number, r: { cnt: number }) => sum + (r.cnt - 1),
      0,
    );
    const sample_values: string[] = dupResult.rows
      .slice(0, 5)
      .map((r: { val: string }) => r.val);

    return { duplicate_count, sample_values };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `checkUniqueViolations(${tableName}.${columnName}): ${message}`,
    );
  }
}

/**
 * List all constraints on a table and report their validation status.
 */
export async function checkConstraintViolations(
  pool: Pool,
  tableName: string,
): Promise<
  Array<{
    constraint_name: string;
    constraint_type: string;
    is_valid: boolean;
  }>
> {
  try {
    const result = await pool.query(
      `${TIMEOUT_PREFIX}
       SELECT con.conname                    AS constraint_name,
              CASE con.contype
                WHEN 'p' THEN 'PRIMARY KEY'
                WHEN 'f' THEN 'FOREIGN KEY'
                WHEN 'u' THEN 'UNIQUE'
                WHEN 'c' THEN 'CHECK'
                WHEN 'x' THEN 'EXCLUSION'
                ELSE con.contype::text
              END                            AS constraint_type,
              con.convalidated               AS is_valid
       FROM pg_constraint con
       JOIN pg_class cls     ON cls.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
       WHERE cls.relname = $1
         AND nsp.nspname = 'public'
       ORDER BY con.conname`,
      [tableName],
    );

    return result.rows.map(
      (r: {
        constraint_name: string;
        constraint_type: string;
        is_valid: boolean;
      }) => ({
        constraint_name: r.constraint_name,
        constraint_type: r.constraint_type,
        is_valid: r.is_valid,
      }),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `checkConstraintViolations(${tableName}): ${message}`,
    );
  }
}

/**
 * Return the exact row count for a table.
 */
export async function getRowCount(
  pool: Pool,
  tableName: string,
): Promise<number> {
  try {
    const tbl = quoteIdent(tableName);
    const result = await pool.query(
      `${TIMEOUT_PREFIX} SELECT count(*)::int AS cnt FROM ${tbl}`,
    );
    return result.rows[0]?.cnt ?? 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`getRowCount(${tableName}): ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregate check
// ---------------------------------------------------------------------------

/**
 * Run every invariant check against a table and return a unified report.
 *
 * If `columnName` is omitted the NOT-NULL and UNIQUE checks are skipped
 * (they require a specific column to inspect).
 */
export async function runAllChecks(
  pool: Pool,
  tableName: string,
  columnName?: string,
): Promise<InvariantReport> {
  const checked_at = new Date().toISOString();

  const row_count = await getRowCount(pool, tableName);

  let null_violations = 0;
  if (columnName) {
    const nv = await checkNotNullViolations(pool, tableName, columnName);
    null_violations = nv.count;
  }

  const fkResult = await checkForeignKeyIntegrity(pool, tableName);

  let unique_violations = 0;
  if (columnName) {
    const uv = await checkUniqueViolations(pool, tableName, columnName);
    unique_violations = uv.duplicate_count;
  }

  const constraintList = await checkConstraintViolations(pool, tableName);
  const constraints_valid = constraintList.every((c) => c.is_valid);

  return {
    table: tableName,
    row_count,
    null_violations,
    fk_violations: fkResult.violations,
    unique_violations,
    constraints_valid,
    checked_at,
  };
}
