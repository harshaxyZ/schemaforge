/**
 * SchemaForge v2.0 — Tool: db_inspect_schema
 * Safety Tier: 0 (read-only, no approval needed)
 *
 * Inspects the production database schema. When called without arguments,
 * returns a full catalog of all user tables with columns, types, constraints,
 * and indexes. When a specific table_name is provided, returns detailed
 * schema information for that table only.
 *
 * Data sources:
 *   - information_schema.tables / columns / table_constraints / key_column_usage
 *   - pg_catalog.pg_indexes
 *   - pg_catalog.pg_class (for row count estimates)
 *
 * This tool produces a SchemaFingerprint as a side-effect, which is used
 * later by the decision engine to detect schema drift before production mutations.
 */

import pg from 'pg';
import { db } from '../db.js';
import type { SchemaFingerprint } from '../types.js';

export interface InspectSchemaInput {
  /** Optional: restrict inspection to a single table. */
  table_name?: string;
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  character_maximum_length: number | null;
  ordinal_position: number;
}

export interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  foreign_table?: string;
  foreign_column?: string;
}

export interface IndexInfo {
  index_name: string;
  index_definition: string;
  is_unique: boolean;
}

export interface TableSchema {
  table_name: string;
  estimated_row_count: number;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

export interface InspectSchemaResult {
  tables: TableSchema[];
  fingerprint: SchemaFingerprint;
}

/**
 * Inspect the production database schema.
 *
 * @param input — optional table filter
 * @returns full schema inspection with a cryptographic fingerprint
 */
export async function inspectSchema(input: InspectSchemaInput): Promise<InspectSchemaResult> {
  const { table_name } = input;

  // ── Fetch table list ──
  const tableFilter = table_name
    ? `AND t.table_name = $1`
    : '';
  const tableParams = table_name ? [table_name] : [];

  const tablesQuery = `
    SELECT t.table_name,
           c.reltuples::bigint AS estimated_row_count
    FROM information_schema.tables t
    JOIN pg_catalog.pg_class c ON c.relname = t.table_name
    WHERE t.table_schema IN ('schemaforge', 'public')
      AND t.table_type = 'BASE TABLE'
      ${tableFilter}
    ORDER BY t.table_name
  `;

  const tablesResult = await db.query('prodReadonly', tablesQuery, tableParams);

  const tables: TableSchema[] = [];

  for (const row of tablesResult.rows) {
    const tblName = row.table_name as string;

    // ── Columns ──
    const colsResult = await db.query(
      'prodReadonly',
      `SELECT column_name, data_type, is_nullable, column_default,
              character_maximum_length, ordinal_position
       FROM information_schema.columns
       WHERE table_schema IN ('schemaforge', 'public') AND table_name = $1
       ORDER BY ordinal_position`,
      [tblName],
    );

    const columns: ColumnInfo[] = colsResult.rows.map((c) => ({
      column_name: c.column_name as string,
      data_type: c.data_type as string,
      is_nullable: c.is_nullable === 'YES',
      column_default: c.column_default as string | null,
      character_maximum_length: c.character_maximum_length as number | null,
      ordinal_position: c.ordinal_position as number,
    }));

    // ── Constraints ──
    const constraintsResult = await db.query(
      'prodReadonly',
      `SELECT tc.constraint_name, tc.constraint_type,
              kcu.column_name,
              ccu.table_name  AS foreign_table,
              ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema = ccu.table_schema
         AND tc.constraint_type = 'FOREIGN KEY'
       WHERE tc.table_schema IN ('schemaforge', 'public') AND tc.table_name = $1
       ORDER BY tc.constraint_type, tc.constraint_name`,
      [tblName],
    );

    const constraints: ConstraintInfo[] = constraintsResult.rows.map((c) => ({
      constraint_name: c.constraint_name as string,
      constraint_type: c.constraint_type as string,
      column_name: c.column_name as string,
      ...(c.foreign_table ? { foreign_table: c.foreign_table as string } : {}),
      ...(c.foreign_column ? { foreign_column: c.foreign_column as string } : {}),
    }));

    // ── Indexes ──
    const indexesResult = await db.query(
      'prodReadonly',
      `SELECT indexname  AS index_name,
              indexdef   AS index_definition,
              (indexdef ILIKE '%UNIQUE%') AS is_unique
       FROM pg_indexes
       WHERE schemaname IN ('schemaforge', 'public') AND tablename = $1
       ORDER BY indexname`,
      [tblName],
    );

    const indexes: IndexInfo[] = indexesResult.rows.map((i) => ({
      index_name: i.index_name as string,
      index_definition: i.index_definition as string,
      is_unique: Boolean(i.is_unique),
    }));

    tables.push({
      table_name: tblName,
      estimated_row_count: Number(row.estimated_row_count),
      columns,
      constraints,
      indexes,
    });
  }

  // ── Build fingerprint ──
  const crypto = await import('node:crypto');
  const canonical = JSON.stringify(tables);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const fingerprint: SchemaFingerprint = {
    hash,
    captured_at: new Date().toISOString(),
    tables: tables.map((t) => t.table_name),
  };

  return { tables, fingerprint };
}

/**
 * Inspect schema using a pre-existing client (for use inside transactions).
 * Mirrors inspectSchema but uses the raw client instead of db.query().
 */
export async function inspectSchemaWithClient(
  client: pg.PoolClient,
  tableName?: string,
): Promise<InspectSchemaResult> {
  const tableFilter = tableName ? `AND t.table_name = $1` : '';
  const tableParams = tableName ? [tableName] : [];

  const tablesResult = await client.query(
    `SELECT t.table_name,
            c.reltuples::bigint AS estimated_row_count
     FROM information_schema.tables t
     JOIN pg_catalog.pg_class c ON c.relname = t.table_name
     WHERE t.table_schema IN ('schemaforge', 'public')
       AND t.table_type = 'BASE TABLE'
       ${tableFilter}
     ORDER BY t.table_name`,
    tableParams,
  );

  const tables: TableSchema[] = [];

  for (const row of tablesResult.rows) {
    const tblName = row.table_name as string;

    const colsResult = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default,
              character_maximum_length, ordinal_position
       FROM information_schema.columns
       WHERE table_schema IN ('schemaforge', 'public') AND table_name = $1
       ORDER BY ordinal_position`,
      [tblName],
    );

    const columns: ColumnInfo[] = colsResult.rows.map((c: any) => ({
      column_name: c.column_name as string,
      data_type: c.data_type as string,
      is_nullable: c.is_nullable === 'YES',
      column_default: c.column_default as string | null,
      character_maximum_length: c.character_maximum_length as number | null,
      ordinal_position: c.ordinal_position as number,
    }));

    const constraintsResult = await client.query(
      `SELECT tc.constraint_name, tc.constraint_type,
              kcu.column_name,
              ccu.table_name  AS foreign_table,
              ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema = ccu.table_schema
         AND tc.constraint_type = 'FOREIGN KEY'
       WHERE tc.table_schema IN ('schemaforge', 'public') AND tc.table_name = $1
       ORDER BY tc.constraint_type, tc.constraint_name`,
      [tblName],
    );

    const constraints: ConstraintInfo[] = constraintsResult.rows.map((c: any) => ({
      constraint_name: c.constraint_name as string,
      constraint_type: c.constraint_type as string,
      column_name: c.column_name as string,
      ...(c.foreign_table ? { foreign_table: c.foreign_table as string } : {}),
      ...(c.foreign_column ? { foreign_column: c.foreign_column as string } : {}),
    }));

    const indexesResult = await client.query(
      `SELECT indexname  AS index_name,
              indexdef   AS index_definition,
              (indexdef ILIKE '%UNIQUE%') AS is_unique
       FROM pg_indexes
       WHERE schemaname IN ('schemaforge', 'public') AND tablename = $1
       ORDER BY indexname`,
      [tblName],
    );

    const indexes: IndexInfo[] = indexesResult.rows.map((i: any) => ({
      index_name: i.index_name as string,
      index_definition: i.index_definition as string,
      is_unique: Boolean(i.is_unique),
    }));

    tables.push({
      table_name: tblName,
      estimated_row_count: Number(row.estimated_row_count),
      columns,
      constraints,
      indexes,
    });
  }

  const crypto = await import('node:crypto');
  const canonical = JSON.stringify(tables);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const fingerprint: SchemaFingerprint = {
    hash,
    captured_at: new Date().toISOString(),
    tables: tables.map((t) => t.table_name),
  };

  return { tables, fingerprint };
}

