/**
 * SchemaForge v2.0 — Validated runtime configuration.
 *
 * Every process (sf-core, sf-executor, the approval CLI, the test suite) reads
 * its configuration through this module. Environment variables use a single
 * `SF_` prefix and are validated with zod so a misconfigured deployment fails
 * immediately with an actionable message instead of at the first tool call.
 *
 * Credential separation is enforced here, not merely documented:
 *   • sf-core    MUST NOT see SF_PROD_WRITE_URL or SF_APPROVAL_SECRET.
 *   • sf-executor MUST see both, plus the read-only URL for drift detection.
 */

import { z } from 'zod';

/** Which SchemaForge process is loading the configuration. */
export type ProcessRole = 'core' | 'executor' | 'cli';

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// connection string',
  });

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const baseSchema = z.object({
  /** SELECT-only role against the production target. */
  SF_PROD_READONLY_URL: postgresUrl,
  /** Owner role on the shadow container. Creates and drops rehearsal databases. */
  SF_SHADOW_URL: postgresUrl,
  /** Write role on production. Held by sf-executor only. */
  SF_PROD_WRITE_URL: postgresUrl.optional(),
  /** HMAC key used to sign and verify approvals. Held by sf-executor and the CLI only. */
  SF_APPROVAL_SECRET: z.string().min(32).optional(),

  /** Default statement timeout for tool queries, in milliseconds. */
  SF_STATEMENT_TIMEOUT_MS: positiveInt(10_000),
  /** Timeout for DDL executed during rehearsal, in milliseconds. */
  SF_REHEARSAL_TIMEOUT_MS: positiveInt(120_000),
  /** Timeout for DDL executed against production, in milliseconds. */
  SF_MIGRATION_TIMEOUT_MS: positiveInt(120_000),
  /** lock_timeout applied to production DDL. Keeps a blocked migration from queueing traffic. */
  SF_LOCK_TIMEOUT_MS: positiveInt(3_000),
  /** Lifetime of a signed approval, in seconds. */
  SF_APPROVAL_TTL_SECONDS: positiveInt(300),

  /** Template database in the shadow container that rehearsal copies are cloned from. */
  SF_SHADOW_BASELINE_DB: z.string().min(1).default('sf_baseline'),
  /** Maintenance database used to issue CREATE/DROP DATABASE on the shadow container. */
  SF_SHADOW_MAINTENANCE_DB: z.string().min(1).default('postgres'),

  /** Optional application repository scanned for references to affected schema objects. */
  SF_APP_REPO_PATH: z.string().optional(),
  /** Hard cap on rows returned by the read-only query tool. */
  SF_MAX_RESULT_ROWS: positiveInt(1_000),
});

export type SchemaForgeConfig = z.infer<typeof baseSchema> & {
  role: ProcessRole;
};

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Parse and validate the environment for the given process role.
 *
 * @throws if a required variable is missing, malformed, or present in a
 *         process that must not hold it.
 */
export function loadConfig(
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
): SchemaForgeConfig {
  const parsed = baseSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(
      `SchemaForge configuration is invalid:\n${describeIssues(parsed.error)}\n` +
        'See .env.example for the full list of supported variables.',
    );
  }

  const config = parsed.data;

  if (role === 'core') {
    // The agent loop must not be able to reach production with write access,
    // and must not be able to mint its own approvals.
    if (config.SF_PROD_WRITE_URL) {
      throw new Error(
        'Refusing to start sf-core: SF_PROD_WRITE_URL is set. Production write ' +
          'credentials belong to sf-executor only. Remove it from this process environment.',
      );
    }
    if (config.SF_APPROVAL_SECRET) {
      throw new Error(
        'Refusing to start sf-core: SF_APPROVAL_SECRET is set. The signing key belongs ' +
          'to sf-executor and the approval CLI only. Remove it from this process environment.',
      );
    }
  }

  if (role === 'executor') {
    if (!config.SF_PROD_WRITE_URL) {
      throw new Error(
        'Refusing to start sf-executor: SF_PROD_WRITE_URL is required to apply migrations.',
      );
    }
    if (!config.SF_APPROVAL_SECRET) {
      throw new Error(
        'Refusing to start sf-executor: SF_APPROVAL_SECRET is required to verify approvals.',
      );
    }
  }

  if (role === 'cli' && !config.SF_APPROVAL_SECRET) {
    throw new Error(
      'Refusing to start the approval CLI: SF_APPROVAL_SECRET is required to sign approvals.',
    );
  }

  return { ...config, role };
}

/** Read the approval signing key as raw bytes. */
export function approvalSecret(config: SchemaForgeConfig): Buffer {
  if (!config.SF_APPROVAL_SECRET) {
    throw new Error('SF_APPROVAL_SECRET is not available in this process.');
  }
  return Buffer.from(config.SF_APPROVAL_SECRET, 'utf8');
}
