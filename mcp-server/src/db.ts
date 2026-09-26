/** Role-scoped PostgreSQL pools and connection-scoped transaction primitives. */

import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { ProcessRole } from './config.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export type PoolName = 'prodReadonly' | 'prodWrite' | 'shadow';

export interface TransactionOptions {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

function positiveEnvInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class DatabaseManager {
  private readonly pools = new Map<PoolName, PgPool>();
  private configuredRole: Exclude<ProcessRole, 'cli'> | null = null;
  private statementTimeoutMs = 10_000;

  /** Create only the pools authorized for this already-validated process role. */
  configure(role: Exclude<ProcessRole, 'cli'>, env: NodeJS.ProcessEnv = process.env): void {
    if (this.configuredRole) {
      if (this.configuredRole !== role) throw new Error(`Database manager is already configured for ${this.configuredRole}.`);
      return;
    }

    this.statementTimeoutMs = positiveEnvInt(env, 'SF_STATEMENT_TIMEOUT_MS', 10_000);
    if (role === 'core') {
      this.addPool('prodReadonly', env.SF_PROD_READONLY_URL, 5);
      this.addPool('shadow', env.SF_SHADOW_URL, 3);
    } else {
      this.addPool('prodReadonly', env.SF_PROD_READONLY_URL, 2);
      this.addPool('prodWrite', env.SF_PROD_WRITE_URL, 1);
    }
    this.configuredRole = role;
  }

  private addPool(name: PoolName, connectionString: string | undefined, max: number): void {
    if (!connectionString) throw new Error(`Missing connection string for ${name}.`);
    this.pools.set(
      name,
      new Pool({
        application_name: `schemaforge-${name}`,
        connectionString,
        max,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    );
  }

  getPool(name: PoolName): PgPool {
    if (!this.configuredRole) throw new Error('Database manager has not been configured.');
    const pool = this.pools.get(name);
    if (!pool) throw new Error(`Database pool "${name}" is not authorized for the ${this.configuredRole} process.`);
    return pool;
  }

  async withClient<T>(name: PoolName, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool(name).connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  private async configureTransaction(client: PoolClient, options: TransactionOptions): Promise<void> {
    if (options.isolationLevel) {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
    }
    if (options.readOnly) await client.query('SET TRANSACTION READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${options.statementTimeoutMs ?? this.statementTimeoutMs}ms`,
    ]);
    if (options.lockTimeoutMs !== undefined) {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${options.lockTimeoutMs}ms`]);
    }
  }

  async withTransaction<T>(
    name: PoolName,
    callback: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const client = await this.getPool(name).connect();
    let discardClient = false;
    try {
      await client.query('BEGIN');
      await this.configureTransaction(client, options);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discardClient = true; }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  /** Run work in a transaction that can never commit, and prove cleanup succeeded. */
  async withRollbackTransaction<T>(
    name: PoolName,
    callback: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const client = await this.getPool(name).connect();
    let transactionOpen = false;
    let discardClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await this.configureTransaction(client, options);
      const result = await callback(client);
      await client.query('ROLLBACK');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
          transactionOpen = false;
        } catch (rollbackError) {
          discardClient = true;
          throw new AggregateError(
            [error, rollbackError],
            'Shadow operation failed and rollback could not be confirmed; the connection was destroyed.',
          );
        }
      }
      throw error;
    } finally {
      client.release(discardClient || transactionOpen);
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    poolName: PoolName,
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<QueryResult<R>> {
    return this.withClient(poolName, async (client) => {
      try {
        await client.query("SELECT set_config('statement_timeout', $1, false)", [
          `${timeoutMs ?? this.statementTimeoutMs}ms`,
        ]);
        return await client.query<R>(sql, params);
      } finally {
        await client.query('RESET statement_timeout').catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
    this.configuredRole = null;
  }
}

export const db = new DatabaseManager();
