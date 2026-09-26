/** Scenario fixtures derived from the repo's own seed files and source contracts. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

export const CORE_TOOLS = [
  'analyze_dependencies',
  'db_inspect_schema',
  'db_run_readonly_query',
  'rehearse_migration',
  'verify_production',
].sort();

export const EXECUTOR_TOOLS = ['execute_migration'];

/** Count the user ids that EDGE CASE 1 in shadow/seed-edge-cases.sql sets to NULL email. */
export function seededNullEmailCount(): number {
  const sql = readFileSync(path.join(REPO_ROOT, 'shadow', 'seed-edge-cases.sql'), 'utf8');
  const match = sql.match(/UPDATE\s+users\s+SET\s+email\s*=\s*NULL[\s\S]*?WHERE\s+id\s+IN\s*\(([\s\S]*?)\);/i);
  if (!match) throw new Error('Could not find the NULL-email seed block in seed-edge-cases.sql');
  const withoutComments = match[1].replace(/--[^\n]*/g, '');
  return withoutComments.split(',').map((item) => item.trim()).filter((item) => /^\d+$/.test(item)).length;
}

export const SCENARIO_A = {
  forward_sql: 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
  rollback_sql: 'ALTER TABLE users ALTER COLUMN email DROP NOT NULL;',
  verification_assertions: [
    {
      name: 'users.email is NOT NULL',
      query:
        "SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'",
      expectation: 'first_value_true' as const,
    },
  ],
};

export const ARCHIVED_AT_EXISTS =
  "SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'archived_at'";

export const SCENARIO_B = {
  forward_sql: 'ALTER TABLE users ADD COLUMN archived_at TIMESTAMPTZ;',
  rollback_sql: 'ALTER TABLE users DROP COLUMN archived_at;',
  verification_assertions: [
    {
      name: 'users.archived_at exists and is nullable',
      query:
        "SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'archived_at'",
      expectation: 'first_value_true' as const,
    },
  ],
};
