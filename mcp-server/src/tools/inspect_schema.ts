/** Read-only PostgreSQL catalog inspection with stable schema fingerprinting. */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../db.js';
import type { SchemaFingerprint } from '../types.js';

export interface InspectSchemaInput { table_name?: string }

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  formatted_type: string;
  is_nullable: boolean;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  datetime_precision: number | null;
  collation_name: string | null;
  domain_schema: string | null;
  domain_name: string | null;
  udt_schema: string;
  udt_name: string;
  is_identity: boolean;
  identity_generation: string | null;
  is_generated: string;
  generation_expression: string | null;
  storage_strategy: string;
  compression_method: string;
  ordinal_position: number;
}

export interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  definition: string;
  validated: boolean;
  foreign_table?: string;
  foreign_column?: string;
}

export interface IndexInfo {
  index_name: string;
  index_definition: string;
  is_unique: boolean;
  is_valid: boolean;
  is_ready: boolean;
  options: string[];
}

export interface TableSchema {
  table_name: string;
  estimated_row_count: number;
  relation_kind: string;
  persistence: string;
  row_level_security: boolean;
  force_row_level_security: boolean;
  replica_identity: string;
  tablespace: string;
  access_method: string | null;
  options: string[];
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

export interface ViewInfo {
  view_name: string;
  definition: string;
  options: string[];
}

export interface InspectSchemaResult {
  database: { name: string; server_version: string; extensions: string[] };
  tables: TableSchema[];
  views: ViewInfo[];
  fingerprint: SchemaFingerprint;
}

const INTERNAL_TABLES = ['schemaforge_execution_ledger'];

export async function inspectSchemaWithClient(
  client: PoolClient,
  input: InspectSchemaInput = {},
): Promise<InspectSchemaResult> {
  const metadata = await client.query<{ name: string; server_version: string }>(
    `SELECT current_database() AS name, current_setting('server_version') AS server_version`,
  );
  const extensionsResult = await client.query<{ extname: string; extversion: string }>(
    'SELECT extname, extversion FROM pg_extension ORDER BY extname',
  );

  const params: unknown[] = [INTERNAL_TABLES];
  const tableFilter = input.table_name ? 'AND c.relname = $2' : '';
  if (input.table_name) params.push(input.table_name);

  const tableRows = await client.query<{
    table_name: string;
    estimated_row_count: string;
    relation_kind: string;
    persistence: string;
    row_level_security: boolean;
    force_row_level_security: boolean;
    replica_identity: string;
    tablespace: string;
    access_method: string | null;
    options: string[] | null;
  }>(
    `SELECT c.relname AS table_name,
            c.reltuples::bigint AS estimated_row_count,
            c.relkind::text AS relation_kind,
            c.relpersistence::text AS persistence,
            c.relrowsecurity AS row_level_security,
            c.relforcerowsecurity AS force_row_level_security,
            c.relreplident::text AS replica_identity,
            COALESCE(space.spcname, 'pg_default') AS tablespace,
            access.amname AS access_method,
            c.reloptions AS options
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_tablespace space ON space.oid = c.reltablespace
       LEFT JOIN pg_am access ON access.oid = c.relam
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT (c.relname = ANY($1::text[]))
        ${tableFilter}
      ORDER BY c.relname`,
    params,
  );

  const tables: TableSchema[] = [];
  for (const row of tableRows.rows) {
    const tableName = row.table_name;
    const columnsResult = await client.query<{
      column_name: string;
      data_type: string;
      formatted_type: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      datetime_precision: number | null;
      collation_name: string | null;
      domain_schema: string | null;
      domain_name: string | null;
      udt_schema: string;
      udt_name: string;
      is_identity: string;
      identity_generation: string | null;
      is_generated: string;
      generation_expression: string | null;
      storage_strategy: string;
      compression_method: string;
      ordinal_position: number;
    }>(
      `SELECT col.column_name, col.data_type,
              format_type(attr.atttypid, attr.atttypmod) AS formatted_type,
              col.is_nullable, col.column_default, col.character_maximum_length,
              col.numeric_precision, col.numeric_scale, col.datetime_precision,
              col.collation_name, col.domain_schema, col.domain_name,
              col.udt_schema, col.udt_name, col.is_identity, col.identity_generation,
              col.is_generated, col.generation_expression,
              attr.attstorage::text AS storage_strategy,
              attr.attcompression::text AS compression_method,
              col.ordinal_position
         FROM information_schema.columns col
         JOIN pg_class rel ON rel.oid = to_regclass(format('%I.%I', 'public', $1))
         JOIN pg_attribute attr ON attr.attrelid = rel.oid AND attr.attname = col.column_name
        WHERE col.table_schema = 'public' AND col.table_name = $1
        ORDER BY col.ordinal_position`,
      [tableName],
    );

    const constraintsResult = await client.query<{
      constraint_name: string;
      constraint_type: string;
      column_name: string | null;
      definition: string;
      validated: boolean;
      foreign_table: string | null;
      foreign_column: string | null;
    }>(
      `SELECT con.conname AS constraint_name,
              CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE'
                WHEN 'f' THEN 'FOREIGN KEY' WHEN 'c' THEN 'CHECK'
                WHEN 'x' THEN 'EXCLUDE' ELSE con.contype::text END AS constraint_type,
              (SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY key(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
                ORDER BY key.ord LIMIT 1) AS column_name,
              pg_get_constraintdef(con.oid, true) AS definition,
              con.convalidated AS validated,
              CASE WHEN con.confrelid <> 0 THEN con.confrelid::regclass::text END AS foreign_table,
              (SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY key(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = key.attnum
                ORDER BY key.ord LIMIT 1) AS foreign_column
         FROM pg_constraint con
        WHERE con.conrelid = to_regclass(format('%I.%I', 'public', $1))
        ORDER BY con.contype, con.conname`,
      [tableName],
    );

    const indexesResult = await client.query<{
      index_name: string;
      index_definition: string;
      is_unique: boolean;
      is_valid: boolean;
      is_ready: boolean;
      options: string[] | null;
    }>(
      `SELECT index_rel.relname AS index_name,
              pg_get_indexdef(index_rel.oid) AS index_definition,
              idx.indisunique AS is_unique, idx.indisvalid AS is_valid,
              idx.indisready AS is_ready, index_rel.reloptions AS options
         FROM pg_index idx
         JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
        WHERE idx.indrelid = to_regclass(format('%I.%I', 'public', $1))
        ORDER BY index_rel.relname`,
      [tableName],
    );

    tables.push({
      table_name: tableName,
      estimated_row_count: Number(row.estimated_row_count),
      relation_kind: row.relation_kind,
      persistence: row.persistence,
      row_level_security: row.row_level_security,
      force_row_level_security: row.force_row_level_security,
      replica_identity: row.replica_identity,
      tablespace: row.tablespace,
      access_method: row.access_method,
      options: row.options ?? [],
      columns: columnsResult.rows.map((column) => ({
        ...column,
        is_nullable: column.is_nullable === 'YES',
        is_identity: column.is_identity === 'YES',
      })),
      constraints: constraintsResult.rows.map((constraint) => ({
        constraint_name: constraint.constraint_name,
        constraint_type: constraint.constraint_type,
        column_name: constraint.column_name ?? '',
        definition: constraint.definition,
        validated: constraint.validated,
        ...(constraint.foreign_table ? { foreign_table: constraint.foreign_table } : {}),
        ...(constraint.foreign_column ? { foreign_column: constraint.foreign_column } : {}),
      })),
      indexes: indexesResult.rows.map((index) => ({ ...index, options: index.options ?? [] })),
    });
  }

  const viewsResult = await client.query<{ view_name: string; definition: string; options: string[] | null }>(
    `SELECT view.relname AS view_name, pg_get_viewdef(view.oid, true) AS definition,
            view.reloptions AS options
       FROM pg_class view
       JOIN pg_namespace ns ON ns.oid = view.relnamespace
      WHERE ns.nspname = 'public' AND view.relkind = 'v'
      ORDER BY view.relname`,
  );

  const extensions = extensionsResult.rows.map((row) => row.extname);
  const views = input.table_name
    ? []
    : viewsResult.rows.map((view) => ({ ...view, options: view.options ?? [] }));
  const canonical = JSON.stringify({
    extensions: extensionsResult.rows,
    tables: tables.map(({ estimated_row_count: _estimate, ...schema }) => schema),
    views,
  });
  const fingerprint: SchemaFingerprint = {
    hash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'),
    captured_at: new Date().toISOString(),
    tables: tables.map((table) => table.table_name),
  };

  return {
    database: {
      name: metadata.rows[0]?.name ?? 'unknown',
      server_version: metadata.rows[0]?.server_version ?? 'unknown',
      extensions,
    },
    tables,
    views,
    fingerprint,
  };
}

export async function inspectSchema(input: InspectSchemaInput): Promise<InspectSchemaResult> {
  return db.withTransaction(
    'prodReadonly',
    (client) => inspectSchemaWithClient(client, input),
    { readOnly: true, isolationLevel: 'REPEATABLE READ' },
  );
}
