/**
 * SchemaForge v2.0 — Database Connection Manager.
 *
 * Manages three isolated connection pools:
 *   • prodReadonly  — SELECT-only access to production
 *   • prodWrite     — gated behind ApprovalToken for mutations
 *   • shadow        — full access to the disposable shadow DB
 *
 * All queries enforce a statement_timeout to prevent runaway operations.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, '..', '..', '.env');
  dotenv.config({ path: envPath });
  dotenv.config();
} catch (e) {}

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

/** Names of the managed connection pools. */
export type PoolName = 'prodReadonly' | 'prodWrite' | 'shadow';

/** Default statement timeout in milliseconds (10 seconds). */
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export interface TransactionOptions {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

/**
 * Centralized database connection manager for SchemaForge.
 */
export class DatabaseManager {
  private pools: Map<PoolName, PgPool> = new Map();
  private statementTimeoutMs: number;

  constructor() {
    this.statementTimeoutMs = parseInt(
      process.env.SF_STATEMENT_TIMEOUT ?? String(DEFAULT_STATEMENT_TIMEOUT_MS),
      10,
    );

    // ── Production read-only pool ──
    const prodReadonlyUrl =
      process.env.SF_PROD_READONLY_URL ||
      process.env.DATABASE_READONLY_URL ||
      process.env.PROD_READONLY_URL ||
      process.env.DATABASE_URL;

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

    // ── Production write pool — used ONLY by execute_migration ──
    const prodWriteUrl =
      process.env.SF_PROD_WRITE_URL ||
      process.env.DATABASE_URL ||
      process.env.PROD_DATABASE_URL;

    if (prodWriteUrl) {
      this.pools.set(
        'prodWrite',
        new Pool({
          connectionString: prodWriteUrl,
          max: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        }),
      );
    }

    // ── Shadow pool — disposable rehearsal database ──
    const shadowUrl =
      process.env.SF_SHADOW_URL ||
      process.env.SHADOW_DATABASE_URL ||
      process.env.DATABASE_URL;

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

    // Log connection status
    const connected = Array.from(this.pools.keys());
    console.log(`[SchemaForge DB] Pools initialized: ${connected.join(', ') || 'NONE'}`);
    if (connected.length === 0) {
      console.error('[SchemaForge DB] WARNING: No database URLs configured! Set DATABASE_URL in .env');
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
   */
  async query<T extends pg.QueryResultRow = any>(
    pool: PoolName,
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<pg.QueryResult<T>> {
    const pgPool = this.getPool(pool);
    const client = await pgPool.connect();
    const timeout = timeoutMs ?? this.statementTimeoutMs;

    try {
      await client.query(`SET statement_timeout = ${timeout}`);
      const result = await client.query<T>(sql, params);
      return result;
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  }

  /**
   * Execute a transaction on a dedicated client from the named pool.
   * Supports both simple (timeoutMs number) and advanced (TransactionOptions) signatures.
   */
  async withTransaction<T>(
    pool: PoolName,
    callback: (client: pg.PoolClient) => Promise<T>,
    optionsOrTimeout?: number | TransactionOptions,
  ): Promise<T> {
    const pgPool = this.getPool(pool);
    const client = await pgPool.connect();

    const opts: TransactionOptions =
      typeof optionsOrTimeout === 'number'
        ? { statementTimeoutMs: optionsOrTimeout }
        : optionsOrTimeout ?? {};

    const timeout = opts.statementTimeoutMs ?? this.statementTimeoutMs;

    try {
      await client.query(`SET statement_timeout = ${timeout}`);
      if (opts.lockTimeoutMs) {
        await client.query(`SET lock_timeout = ${opts.lockTimeoutMs}`);
      }

      let beginStmt = 'BEGIN';
      if (opts.isolationLevel) {
        beginStmt += ` ISOLATION LEVEL ${opts.isolationLevel}`;
      }
      if (opts.readOnly) {
        beginStmt += ' READ ONLY';
      }

      await client.query(beginStmt);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      await client.query('RESET lock_timeout').catch(() => {});
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
