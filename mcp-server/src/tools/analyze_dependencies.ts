/** Exact PostgreSQL catalog dependency analysis for one public table/column. */

import { db } from '../db.js';

export interface AnalyzeDependenciesInput {
  table_name: string;
  column_name?: string;
}

export interface ForeignKeyDep {
  constraint_name: string;
  source_table: string;
  source_columns: string[];
  target_table: string;
  target_columns: string[];
  direction: 'inbound' | 'outbound';
  definition: string;
}

export interface ViewDep {
  view_name: string;
  view_type: 'view' | 'materialized_view';
  view_definition: string;
}

export interface FunctionDep {
  function_name: string;
  identity_arguments: string;
  source_snippet: string;
}

export interface TriggerDep {
  trigger_name: string;
  definition: string;
  function_name: string;
}

export interface IndexDep {
  index_name: string;
  index_definition: string;
  is_unique: boolean;
  is_valid: boolean;
  columns: string[];
}

export interface PolicyDep {
  policy_name: string;
  command: string;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
}

export interface SequenceDep {
  sequence_name: string;
}

export interface AnalyzeDependenciesResult {
  table_name: string;
  column_name: string | null;
  foreign_keys: ForeignKeyDep[];
  dependent_views: ViewDep[];
  dependent_functions: FunctionDep[];
  triggers: TriggerDep[];
  dependent_indexes: IndexDep[];
  row_level_security_policies: PolicyDep[];
  owned_sequences: SequenceDep[];
  total_dependencies: number;
}

export async function analyzeDependencies(
  input: AnalyzeDependenciesInput,
): Promise<AnalyzeDependenciesResult> {
  const { table_name, column_name } = input;

  return db.withTransaction(
    'prodReadonly',
    async (client) => {
      const relation = await client.query<{ oid: string | null }>(
        `SELECT to_regclass(format('%I.%I', 'public', $1))::oid::text AS oid`,
        [table_name],
      );
      if (!relation.rows[0]?.oid) throw new Error(`public.${table_name} does not exist.`);

      const fkResult = await client.query<{
        constraint_name: string;
        source_table: string;
        source_columns: string[];
        target_table: string;
        target_columns: string[];
        direction: 'inbound' | 'outbound';
        definition: string;
      }>(
        `SELECT con.conname AS constraint_name,
                con.conrelid::regclass::text AS source_table,
                ARRAY(
                  SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY key(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
                  ORDER BY key.ord
                ) AS source_columns,
                con.confrelid::regclass::text AS target_table,
                ARRAY(
                  SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY key(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = key.attnum
                  ORDER BY key.ord
                ) AS target_columns,
                CASE WHEN con.conrelid = to_regclass(format('%I.%I', 'public', $1))
                     THEN 'outbound' ELSE 'inbound' END AS direction,
                pg_get_constraintdef(con.oid, true) AS definition
           FROM pg_constraint con
          WHERE con.contype = 'f'
            AND (con.conrelid = to_regclass(format('%I.%I', 'public', $1))
              OR con.confrelid = to_regclass(format('%I.%I', 'public', $1)))
          ORDER BY con.conname`,
        [table_name],
      );
      const foreignKeys = fkResult.rows.filter((fk) =>
        !column_name || fk.source_columns.includes(column_name) || fk.target_columns.includes(column_name),
      );

      const viewsResult = await client.query<{
        view_name: string;
        view_type: 'view' | 'materialized_view';
        view_definition: string;
      }>(
        `SELECT DISTINCT view_ns.nspname || '.' || view_class.relname AS view_name,
                CASE view_class.relkind WHEN 'm' THEN 'materialized_view' ELSE 'view' END AS view_type,
                pg_get_viewdef(view_class.oid, true) AS view_definition
           FROM pg_depend dep
           JOIN pg_rewrite rewrite ON rewrite.oid = dep.objid
           JOIN pg_class view_class ON view_class.oid = rewrite.ev_class
           JOIN pg_namespace view_ns ON view_ns.oid = view_class.relnamespace
          WHERE dep.refobjid = to_regclass(format('%I.%I', 'public', $1))
            AND view_class.relkind IN ('v', 'm')
          ORDER BY view_name`,
        [table_name],
      );

      const functionsResult = await client.query<{
        function_name: string;
        identity_arguments: string;
        source_snippet: string;
      }>(
        `SELECT DISTINCT ns.nspname || '.' || proc.proname AS function_name,
                pg_get_function_identity_arguments(proc.oid) AS identity_arguments,
                LEFT(pg_get_functiondef(proc.oid), 1000) AS source_snippet
           FROM pg_depend dep
           JOIN pg_proc proc ON proc.oid = dep.objid
           JOIN pg_namespace ns ON ns.oid = proc.pronamespace
          WHERE dep.refobjid = to_regclass(format('%I.%I', 'public', $1))
            AND proc.prokind IN ('f', 'p')
          ORDER BY function_name`,
        [table_name],
      );

      const triggersResult = await client.query<{
        trigger_name: string;
        definition: string;
        function_name: string;
      }>(
        `SELECT trigger.tgname AS trigger_name,
                pg_get_triggerdef(trigger.oid, true) AS definition,
                proc.proname AS function_name
           FROM pg_trigger trigger
           JOIN pg_proc proc ON proc.oid = trigger.tgfoid
          WHERE trigger.tgrelid = to_regclass(format('%I.%I', 'public', $1))
            AND NOT trigger.tgisinternal
          ORDER BY trigger.tgname`,
        [table_name],
      );

      const indexesResult = await client.query<{
        index_name: string;
        index_definition: string;
        is_unique: boolean;
        is_valid: boolean;
        columns: string[];
      }>(
        `SELECT index_class.relname AS index_name,
                pg_get_indexdef(index_class.oid) AS index_definition,
                idx.indisunique AS is_unique,
                idx.indisvalid AS is_valid,
                ARRAY(
                  SELECT pg_get_indexdef(index_class.oid, key_position, true)
                  FROM generate_series(1, idx.indnkeyatts) key_position
                  ORDER BY key_position
                ) AS columns
           FROM pg_index idx
           JOIN pg_class index_class ON index_class.oid = idx.indexrelid
          WHERE idx.indrelid = to_regclass(format('%I.%I', 'public', $1))
          ORDER BY index_class.relname`,
        [table_name],
      );
      const indexes = indexesResult.rows.filter((index) =>
        !column_name || index.columns.some((column) => column.replaceAll('"', '') === column_name),
      );

      const policiesResult = await client.query<{
        policy_name: string;
        command: string;
        roles: string[];
        using_expression: string | null;
        check_expression: string | null;
      }>(
        `SELECT pol.polname AS policy_name,
                pol.polcmd::text AS command,
                ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles) ORDER BY rolname) AS roles,
                pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
                pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expression
           FROM pg_policy pol
          WHERE pol.polrelid = to_regclass(format('%I.%I', 'public', $1))
          ORDER BY pol.polname`,
        [table_name],
      );

      const sequencesResult = await client.query<{ sequence_name: string }>(
        `SELECT seq_ns.nspname || '.' || seq.relname AS sequence_name
           FROM pg_depend dep
           JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
           JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
          WHERE dep.refobjid = to_regclass(format('%I.%I', 'public', $1))
            AND dep.deptype IN ('a', 'i')
          ORDER BY sequence_name`,
        [table_name],
      );

      const total =
        foreignKeys.length +
        viewsResult.rows.length +
        functionsResult.rows.length +
        triggersResult.rows.length +
        indexes.length +
        policiesResult.rows.length +
        sequencesResult.rows.length;

      return {
        table_name,
        column_name: column_name ?? null,
        foreign_keys: foreignKeys,
        dependent_views: viewsResult.rows,
        dependent_functions: functionsResult.rows,
        triggers: triggersResult.rows,
        dependent_indexes: indexes,
        row_level_security_policies: policiesResult.rows,
        owned_sequences: sequencesResult.rows,
        total_dependencies: total,
      };
    },
    { readOnly: true, isolationLevel: 'REPEATABLE READ' },
  );
}
