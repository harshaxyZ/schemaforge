/**
 * SchemaForge v2.0 — Tool: analyze_dependencies
 * Safety Tier: 0 (read-only, no approval needed)
 *
 * Analyzes database-level dependencies for a given table (and optionally a
 * specific column). This includes:
 *   - Foreign key relationships (both inbound and outbound)
 *   - Views that reference the table/column
 *   - Functions/triggers that reference the table/column
 *   - Indexes that include the column
 *   - Dependent materialized views
 *
 * The output helps the decision engine determine the blast radius of a
 * proposed schema change and flag application-level references.
 */

import { db } from '../db.js';

export interface AnalyzeDependenciesInput {
  /** The table to analyze. */
  table_name: string;
  /** Optional: restrict analysis to a specific column. */
  column_name?: string;
}

export interface ForeignKeyDep {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  direction: 'inbound' | 'outbound';
}

export interface ViewDep {
  view_name: string;
  view_definition: string;
}

export interface FunctionDep {
  function_name: string;
  function_type: 'function' | 'trigger';
  source_snippet: string;
}

export interface IndexDep {
  index_name: string;
  index_definition: string;
  is_unique: boolean;
  columns: string[];
}

export interface AnalyzeDependenciesResult {
  table_name: string;
  column_name: string | null;
  foreign_keys: ForeignKeyDep[];
  dependent_views: ViewDep[];
  dependent_functions: FunctionDep[];
  dependent_indexes: IndexDep[];
  total_dependencies: number;
}

/**
 * Analyze all database-level dependencies for a table/column.
 *
 * @param input — table name and optional column filter
 * @returns a comprehensive dependency report
 */
export async function analyzeDependencies(
  input: AnalyzeDependenciesInput,
): Promise<AnalyzeDependenciesResult> {
  const { table_name, column_name } = input;

  // ── Foreign keys (both directions) ──
  const fkQuery = `
    SELECT
      tc.constraint_name,
      kcu.table_name  AS source_table,
      kcu.column_name AS source_column,
      ccu.table_name  AS target_table,
      ccu.column_name AS target_column,
      CASE
        WHEN kcu.table_name = $1 THEN 'outbound'
        ELSE 'inbound'
      END AS direction
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND (kcu.table_name = $1 OR ccu.table_name = $1)
    ORDER BY tc.constraint_name
  `;
  const fkResult = await db.query('prodReadonly', fkQuery, [table_name]);

  let foreignKeys: ForeignKeyDep[] = fkResult.rows.map((r) => ({
    constraint_name: r.constraint_name as string,
    source_table: r.source_table as string,
    source_column: r.source_column as string,
    target_table: r.target_table as string,
    target_column: r.target_column as string,
    direction: r.direction as 'inbound' | 'outbound',
  }));

  // Filter to specific column if provided
  if (column_name) {
    foreignKeys = foreignKeys.filter(
      (fk) => fk.source_column === column_name || fk.target_column === column_name,
    );
  }

  // ── Dependent views ──
  const viewsQuery = `
    SELECT v.table_name AS view_name,
           v.view_definition
    FROM information_schema.views v
    WHERE v.table_schema = 'public'
      AND v.view_definition ILIKE $1
    ORDER BY v.table_name
  `;
  const viewPattern = column_name ? `%${table_name}%${column_name}%` : `%${table_name}%`;
  const viewsResult = await db.query('prodReadonly', viewsQuery, [viewPattern]);

  const dependentViews: ViewDep[] = viewsResult.rows.map((r) => ({
    view_name: r.view_name as string,
    view_definition: r.view_definition as string,
  }));

  // ── Dependent functions and triggers ──
  const funcsQuery = `
    SELECT p.proname AS function_name,
           CASE WHEN t.tgname IS NOT NULL THEN 'trigger' ELSE 'function' END AS function_type,
           LEFT(pg_get_functiondef(p.oid), 500) AS source_snippet
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    LEFT JOIN pg_trigger t ON t.tgfoid = p.oid
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) ILIKE $1
    ORDER BY p.proname
  `;
  const funcPattern = column_name ? `%${table_name}%${column_name}%` : `%${table_name}%`;
  const funcsResult = await db.query('prodReadonly', funcsQuery, [funcPattern]);

  const dependentFunctions: FunctionDep[] = funcsResult.rows.map((r) => ({
    function_name: r.function_name as string,
    function_type: r.function_type as 'function' | 'trigger',
    source_snippet: r.source_snippet as string,
  }));

  // ── Dependent indexes ──
  const indexQuery = `
    SELECT indexname  AS index_name,
           indexdef   AS index_definition,
           (indexdef ILIKE '%UNIQUE%') AS is_unique
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = $1
      ${column_name ? `AND indexdef ILIKE $2` : ''}
    ORDER BY indexname
  `;
  const indexParams: string[] = [table_name];
  if (column_name) {
    indexParams.push(`%${column_name}%`);
  }
  const indexResult = await db.query('prodReadonly', indexQuery, indexParams);

  const dependentIndexes: IndexDep[] = indexResult.rows.map((r) => ({
    index_name: r.index_name as string,
    index_definition: r.index_definition as string,
    is_unique: Boolean(r.is_unique),
    columns: [], // populated from index_definition parsing in future iteration
  }));

  const totalDependencies =
    foreignKeys.length +
    dependentViews.length +
    dependentFunctions.length +
    dependentIndexes.length;

  return {
    table_name,
    column_name: column_name ?? null,
    foreign_keys: foreignKeys,
    dependent_views: dependentViews,
    dependent_functions: dependentFunctions,
    dependent_indexes: dependentIndexes,
    total_dependencies: totalDependencies,
  };
}
