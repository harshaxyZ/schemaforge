/**
 * SchemaForge v2.0 — Database Connection Manager.
 *
 * Manages three isolated connection pools:
 *   • prodReadonly  — sf_reader role, SELECT-only access to production
 *   • prodWrite     — sf_admin role, gated behind ApprovalToken for mutations
 *   • shadow        — sf_shadow role, full access to the disposable shadow DB
 *
 * All queries enforce a statement_timeout to prevent runaway operations.
 */

import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

/** Names of the managed connection pools. */
export type PoolName = 'prodReadonly' | 'prodWrite' | 'shadow';

/** Default statement timeout in milliseconds (10 seconds). */
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Centralized database connection manager for SchemaForge.
 *
 * Uses environment variables for connection configuration:
 *   - SF_PROD_READONLY_URL  — postgres://sf_reader:...@host/db
 *   - SF_PROD_WRITE_URL     — postgres://sf_admin:...@host/db
 *   - SF_SHADOW_URL         — postgres://sf_shadow:...@host/shadow_db
 *   - SF_STATEMENT_TIMEOUT  — optional override in milliseconds
 */
export class DatabaseManager {
  private pools: Map<PoolName, PgPool> = new Map();
  private statementTimeoutMs: number;

  constructor() {
    this.statementTimeoutMs = parseInt(
      process.env.SF_STATEMENT_TIMEOUT ?? String(DEFAULT_STATEMENT_TIMEOUT_MS),
      10,
    );

    // ── Production read-only pool (sf_reader) ──
    const prodReadonlyUrl = process.env.SF_PROD_READONLY_URL;
    if (prodReadonlyUrl) {
      this.pools.set(
        'prodReadonly',
        new Pool({
          connectionString: prodReadonlyUrl,
          max: 5,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        }),
      );
    }

    // ── Production write pool (sf_admin) — used ONLY by execute_migration ──
    const prodWriteUrl = process.env.SF_PROD_WRITE_URL;
    if (prodWriteUrl) {
      this.pools.set(
        'prodWrite',
        new Pool({
          connectionString: prodWriteUrl,
          max: 2, // intentionally small — mutations are rare and serialized
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        }),
      );
    }

    // ── Shadow pool (sf_shadow) — disposable rehearsal database ──
    const shadowUrl = process.env.SF_SHADOW_URL;
    if (shadowUrl) {
      this.pools.set(
        'shadow',
        new Pool({
          connectionString: shadowUrl,
          max: 5,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        }),
      );
    }
  }

  /**
   * Retrieve the raw pg Pool by name.
   * Throws if the pool was not configured via environment variables.
   */
  getPool(name: PoolName): PgPool {
    const pool = this.pools.get(name);
    if (!pool) {
      throw new Error(
        `DatabaseManager: pool "${name}" is not configured. ` +
          `Set the corresponding SF_*_URL environment variable.`,
      );
    }
    return pool;
  }

  /**
   * Execute a SQL query against the named pool with statement_timeout enforcement.
   *
   * @param pool   — which connection pool to use
   * @param sql    — the SQL statement to execute
   * @param params — optional bind parameters ($1, $2, …)
   * @param timeoutMs — override the default statement timeout
   * @returns the pg QueryResult
   */
  async query(
    pool: PoolName,
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<pg.QueryResult> {
    const pgPool = this.getPool(pool);
    const client = await pgPool.connect();
    const timeout = timeoutMs ?? this.statementTimeoutMs;

    try {
      // Enforce per-statement timeout at the session level
      await client.query(`SET statement_timeout = ${timeout}`);
      const result = await client.query(sql, params);
      return result;
    } finally {
      // Reset timeout before returning the client to the pool
      await client.query('RESET statement_timeout').catch(() => {
        /* swallow — we're releasing anyway */
      });
      client.release();
    }
  }

  /**
   * Gracefully close all connection pools.
   */
  async close(): Promise<void> {
    const closeTasks: Promise<void>[] = [];
    for (const [name, pool] of this.pools) {
      closeTasks.push(
        pool.end().catch((err: unknown) => {
          console.error(`Error closing pool "${name}":`, err);
        }),
      );
    }
    await Promise.all(closeTasks);
    this.pools.clear();
  }
}

/** Singleton database manager instance. */
export const db = new DatabaseManager();
