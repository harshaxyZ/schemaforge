/** Validated, least-privilege SchemaForge process configuration. */

import { z } from 'zod';

export type ProcessRole = 'core' | 'executor' | 'cli';

const postgresUrl = z.string().min(1).refine(
  (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
  { message: 'must be a postgres:// or postgresql:// connection string' },
);
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]*$/i, 'must be a SQL identifier');

const environmentSchema = z.object({
  SF_PROD_READONLY_URL: postgresUrl.optional(),
  SF_SHADOW_URL: postgresUrl.optional(),
  SF_PROD_WRITE_URL: postgresUrl.optional(),
  SF_APPROVAL_SECRET: z.string().min(32).refine(
    (value) => !value.toLowerCase().includes('replace'),
    { message: 'must be a real random secret, not the example placeholder' },
  ).optional(),
  SF_STATEMENT_TIMEOUT_MS: positiveInt(10_000),
  SF_REHEARSAL_TIMEOUT_MS: positiveInt(120_000),
  SF_MIGRATION_TIMEOUT_MS: positiveInt(120_000),
  SF_LOCK_TIMEOUT_MS: positiveInt(3_000),
  SF_APPROVAL_TTL_SECONDS: positiveInt(300),
  SF_MAX_RESULT_ROWS: positiveInt(1_000),
  SF_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  SF_CORE_PORT: port(3_100),
  SF_EXECUTOR_PORT: port(3_101),
  SF_MCP_API_KEY: z.string().min(24).optional(),
  SF_TARGET_ID: z.string().min(1).max(64).default('prod'),
  SF_LEDGER_TABLE: identifier.default('schemaforge_execution_ledger'),
});

export type SchemaForgeConfig = z.infer<typeof environmentSchema> & { role: ProcessRole };

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

function requireValue<T>(value: T | undefined, name: string, role: ProcessRole): T {
  if (value === undefined) throw new Error(`Refusing to start ${role}: ${name} is required.`);
  return value;
}

function rejectPresent(config: z.infer<typeof environmentSchema>, role: ProcessRole, names: Array<keyof typeof config>): void {
  const present = names.filter((name) => config[name] !== undefined);
  if (present.length > 0) {
    throw new Error(`Refusing to start ${role}: forbidden variables are present: ${present.join(', ')}.`);
  }
}

export function loadConfig(role: ProcessRole, env: NodeJS.ProcessEnv = process.env): SchemaForgeConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `SchemaForge configuration is invalid:\n${describeIssues(parsed.error)}\n` +
        'Copy the matching file from config/*.env.example and fill in real values.',
    );
  }
  const config = parsed.data;

  // In combined mode (hackathon / development), we allow all URLs in one process.
  // In production, separate core and executor processes enforce strict role isolation.
  if (process.env.SF_COMBINED_MODE !== 'true') {
    if (role === 'core') {
      requireValue(config.SF_PROD_READONLY_URL, 'SF_PROD_READONLY_URL', role);
      requireValue(config.SF_SHADOW_URL, 'SF_SHADOW_URL', role);
      rejectPresent(config, role, ['SF_PROD_WRITE_URL', 'SF_APPROVAL_SECRET']);
    } else if (role === 'executor') {
      requireValue(config.SF_PROD_READONLY_URL, 'SF_PROD_READONLY_URL', role);
      requireValue(config.SF_PROD_WRITE_URL, 'SF_PROD_WRITE_URL', role);
      requireValue(config.SF_APPROVAL_SECRET, 'SF_APPROVAL_SECRET', role);
      rejectPresent(config, role, ['SF_SHADOW_URL']);
    } else {
      requireValue(config.SF_APPROVAL_SECRET, 'SF_APPROVAL_SECRET', role);
      rejectPresent(config, role, ['SF_PROD_READONLY_URL', 'SF_PROD_WRITE_URL', 'SF_SHADOW_URL', 'SF_MCP_API_KEY']);
    }
  }

  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (role !== 'cli' && !loopbackHosts.has(config.SF_HTTP_HOST) && !config.SF_MCP_API_KEY) {
    throw new Error('SF_MCP_API_KEY is required when the MCP server binds beyond localhost.');
  }
  return { ...config, role };
}

export function approvalSecret(config: SchemaForgeConfig): Buffer {
  if (!config.SF_APPROVAL_SECRET) throw new Error('SF_APPROVAL_SECRET is unavailable in this process.');
  return Buffer.from(config.SF_APPROVAL_SECRET, 'utf8');
}

export function portForRole(config: SchemaForgeConfig): number {
  if (config.role === 'cli') throw new Error('The approval CLI does not listen on a port.');
  return config.role === 'core' ? config.SF_CORE_PORT : config.SF_EXECUTOR_PORT;
}
