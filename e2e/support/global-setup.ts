/** Vitest global setup: fresh secret, DB probe, and our own core/executor on 3200/3201. */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { coreEnv, executorEnv, readEnv, TMP_DIR, writeRunEnv } from './env.js';
import { spawnSource, stop, waitForHealth } from './process.js';

async function probe(url: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message || error.name : String(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  mkdirSync(TMP_DIR, { recursive: true });
  const base = readEnv();
  const failures = (
    await Promise.all([
      probe(base.E2E_PROD_READONLY_URL),
      probe(base.E2E_SHADOW_URL),
      probe(base.E2E_PROD_ADMIN_URL),
    ])
  ).filter((value): value is string => value !== null);
  const dbAvailable = failures.length === 0;
  if (!dbAvailable) {
    const message = `[e2e] Databases unreachable; DB-backed scenarios will be skipped: ${failures[0]}`;
    if (base.SF_E2E_REQUIRE_DB === '1') throw new Error(message);
    console.warn(message);
  }

  const env = writeRunEnv({ E2E_DB_AVAILABLE: dbAvailable ? '1' : '0' });
  const children: ChildProcess[] = [];
  const teardown = async (): Promise<void> => {
    await Promise.all(children.map((child) => stop(child)));
  };

  // pg pools connect lazily, so both servers boot even when the databases are down.
  const servers: Array<[string, NodeJS.ProcessEnv, string]> = [
    ['core', coreEnv(env), env.E2E_CORE_PORT],
    ['executor', executorEnv(env), env.E2E_EXECUTOR_PORT],
  ];
  try {
    for (const [role, roleEnv, port] of servers) {
      let log = '';
      const child = spawnSource('index.ts', ['--role', role], roleEnv);
      child.stderr?.on('data', (chunk) => (log += chunk));
      children.push(child);
      await waitForHealth(`http://127.0.0.1:${port}/health`, child).catch((error) => {
        throw new Error(`${role} failed to start: ${error}\n${log}`);
      });
    }
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
