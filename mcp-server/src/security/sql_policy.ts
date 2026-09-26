import type { MigrationPolicyAssessment, SqlStatementAssessment } from '../types.js';

export class SqlPolicyError extends Error {
  constructor(
    readonly code: 'EMPTY_SQL' | 'PROHIBITED_SQL' | 'UNSUPPORTED_SQL' | 'NON_TRANSACTIONAL_SQL',
    message: string,
  ) {
    super(message);
    this.name = 'SqlPolicyError';
  }
}

export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n').trim();
}

/**
 * Conservative PostgreSQL lexer used only for a narrow DDL allowlist. Backslash
 * literals are rejected before lexing so server string-mode settings cannot
 * parse more statements than the policy sees.
 */
export function sanitizeSql(sql: string): string {
  if (sql.includes('\\')) {
    throw new SqlPolicyError(
      'UNSUPPORTED_SQL',
      'Backslash-containing SQL is outside the fail-closed lexer subset; use standard quoted values without escapes.',
    );
  }

  let output = '';
  let index = 0;
  let blockDepth = 0;
  let dollarTag: string | null = null;
  let state: 'normal' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'normal';

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === 'line') {
      if (char === '\n') { state = 'normal'; output += '\n'; } else output += ' ';
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '/' && next === '*') { blockDepth += 1; output += '  '; index += 2; }
      else if (char === '*' && next === '/') {
        blockDepth -= 1; output += '  '; index += 2; if (blockDepth === 0) state = 'normal';
      } else { output += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (char === quote && next === quote) { output += '  '; index += 2; }
      else if (char === quote) { state = 'normal'; output += ' '; index += 1; }
      else { output += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'dollar' && dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        output += ' '.repeat(dollarTag.length); index += dollarTag.length; state = 'normal'; dollarTag = null;
      } else { output += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }

    if (char === '-' && next === '-') { state = 'line'; output += '  '; index += 2; }
    else if (char === '/' && next === '*') { state = 'block'; blockDepth = 1; output += '  '; index += 2; }
    else if (char === "'") { state = 'single'; output += ' '; index += 1; }
    else if (char === '"') { state = 'double'; output += ' '; index += 1; }
    else if (char === '$' && (index === 0 || !/[A-Za-z0-9_$]/.test(sql[index - 1]))) {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; state = 'dollar'; output += ' '.repeat(dollarTag.length); index += dollarTag.length; }
      else { output += char; index += 1; }
    } else { output += char; index += 1; }
  }

  if (!['normal', 'line'].includes(state)) {
    throw new SqlPolicyError('UNSUPPORTED_SQL', 'SQL contains an unterminated comment or quoted value.');
  }
  return output;
}

export function splitSqlStatements(sql: string): string[] {
  return sanitizeSql(normalizeMigrationSql(sql))
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const prohibitedRules: Array<[RegExp, string]> = [
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA|ROLE|USER|TABLESPACE)\b/i, 'Dropping foundational objects is prohibited'],
  [/\bTRUNCATE\b/i, 'TRUNCATE is prohibited'],
  [/\b(ALTER|CREATE)\s+(ROLE|USER|SYSTEM)\b/i, 'Role and system administration is prohibited'],
  [/^\s*(GRANT|REVOKE)\b/i, 'Permission administration is prohibited'],
  [/\bCOPY\b[\s\S]*\bPROGRAM\b/i, 'COPY PROGRAM is prohibited'],
  [/^\s*(DO|CALL)\b/i, 'Arbitrary procedural execution is outside the allowlist'],
  [/\b(OWNER\s+TO|SET\s+SCHEMA|SET\s+TABLESPACE|REPLICA\s+IDENTITY)\b/i, 'Ownership, schema, tablespace, and replica-identity changes are outside fingerprint coverage'],
  [/\b(SET|RESET)\s*\(/i, 'Relation storage-parameter changes are outside fingerprint coverage'],
  [/\b(ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+(ROW\s+LEVEL\s+SECURITY|TRIGGER)\b/i, 'Security and trigger-state changes are prohibited'],
  [/\b(ATTACH|DETACH)\s+PARTITION\b|\bPARTITION\s+BY\b/i, 'Partition topology changes are outside fingerprint coverage'],
  [/\bALTER\s+COLUMN\b[\s\S]*\b(SET\s+STORAGE|SET\s+COMPRESSION|SET\s+STATISTICS)\b/i, 'Column storage/statistics changes are outside fingerprint coverage'],
  [/^\s*CREATE\s+TABLE\b[\s\S]*\bAS\s+(SELECT|WITH)\b/i, 'CREATE TABLE AS data execution is outside the schema-only executor'],
];

const nonTransactionalRules: Array<[RegExp, string]> = [
  [/\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, 'Concurrent index DDL cannot run in a transaction'],
  [/\bREINDEX\b[\s\S]*\bCONCURRENTLY\b/i, 'REINDEX CONCURRENTLY cannot run in a transaction'],
  [/^\s*VACUUM\b/i, 'VACUUM cannot run in a transaction'],
];

/** Only schema operations represented by the canonical fingerprint are admitted. */
const supportedTransactionalPrefixes = [
  /^ALTER\s+TABLE\b/i,
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX\b/i,
  /^DROP\s+INDEX\b/i,
  /^ALTER\s+INDEX\b/i,
  /^CREATE\s+VIEW\b/i,
  /^DROP\s+VIEW\b/i,
];

function assessStatement(statement: string, index: number): SqlStatementAssessment {
  const preview = statement.slice(0, 160);
  for (const [pattern, reason] of prohibitedRules) {
    if (pattern.test(statement)) return { statement_number: index + 1, classification: 'PROHIBITED', destructive: true, reason, preview };
  }
  for (const [pattern, reason] of nonTransactionalRules) {
    if (pattern.test(statement)) {
      return { statement_number: index + 1, classification: 'NON_TRANSACTIONAL', destructive: /\bDROP\b/i.test(statement), reason, preview };
    }
  }
  if (!supportedTransactionalPrefixes.some((pattern) => pattern.test(statement))) {
    return {
      statement_number: index + 1,
      classification: 'UNSUPPORTED',
      destructive: false,
      reason: 'Only fingerprint-covered schema DDL is accepted; DML and other statements are rejected',
      preview,
    };
  }
  const destructive = /\b(DROP\s+COLUMN|DROP\s+CONSTRAINT|DROP\s+INDEX|DROP\s+VIEW|ALTER\s+COLUMN[\s\S]*\bTYPE\b)\b/i.test(statement);
  return {
    statement_number: index + 1,
    classification: 'TRANSACTIONAL',
    destructive,
    reason: destructive ? 'Transactional but potentially destructive' : 'Supported fingerprint-covered transactional DDL',
    preview,
  };
}

export function assessMigration(sql: string): MigrationPolicyAssessment {
  const normalized = normalizeMigrationSql(sql);
  if (/schemaforge_execution_ledger/i.test(normalized)) {
    throw new SqlPolicyError('PROHIBITED_SQL', 'Migration SQL may not reference the internal execution ledger.');
  }
  const statements = splitSqlStatements(normalized);
  if (statements.length === 0) throw new SqlPolicyError('EMPTY_SQL', 'Migration SQL is empty.');

  const assessments = statements.map(assessStatement);
  const classes = new Set(assessments.map((item) => item.classification));
  let classification: MigrationPolicyAssessment['classification'];
  if (classes.has('PROHIBITED')) classification = 'PROHIBITED';
  else if (classes.has('UNSUPPORTED')) classification = 'UNSUPPORTED';
  else if (classes.size > 1) classification = 'MIXED';
  else if (classes.has('NON_TRANSACTIONAL')) classification = 'NON_TRANSACTIONAL';
  else classification = 'TRANSACTIONAL';
  return { classification, destructive: assessments.some((item) => item.destructive), statements: assessments };
}

export function requireAtomicMigration(sql: string): MigrationPolicyAssessment {
  const assessment = assessMigration(sql);
  if (assessment.classification === 'PROHIBITED') {
    throw new SqlPolicyError('PROHIBITED_SQL', assessment.statements.find((item) => item.classification === 'PROHIBITED')?.reason ?? 'Prohibited SQL');
  }
  if (assessment.classification === 'UNSUPPORTED') {
    throw new SqlPolicyError('UNSUPPORTED_SQL', assessment.statements.find((item) => item.classification === 'UNSUPPORTED')?.reason ?? 'Unsupported SQL');
  }
  if (assessment.classification !== 'TRANSACTIONAL') {
    throw new SqlPolicyError('NON_TRANSACTIONAL_SQL', 'Non-transactional or mixed migrations require a separately designed recovery workflow.');
  }
  return assessment;
}

export function requireReadonlyQuery(sql: string): string {
  const normalized = normalizeMigrationSql(sql).replace(/;+\s*$/, '');
  const statements = splitSqlStatements(normalized);
  if (statements.length !== 1 || !/^\s*(SELECT|WITH)\b/i.test(statements[0] ?? '')) {
    throw new SqlPolicyError('UNSUPPORTED_SQL', 'Only one SELECT or read-only CTE statement is allowed.');
  }
  const statement = statements[0];
  const mutatingCte = /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|MERGE\s+INTO)\b/i;
  const unsafeRead = /\b(FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|INTO\s+(TEMP|TEMPORARY|UNLOGGED)?\s*TABLE|pg_sleep\s*\(|nextval\s*\(|setval\s*\(|lo_(import|export)\s*\(|dblink\s*\()/i;
  if (mutatingCte.test(statement) || unsafeRead.test(statement)) {
    throw new SqlPolicyError('PROHIBITED_SQL', 'The query contains a mutating or unsafe read construct.');
  }
  return normalized;
}
