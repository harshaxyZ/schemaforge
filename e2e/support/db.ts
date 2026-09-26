/** Direct admin access to production, used only for setup steps (schema drift) and cleanup. */
import pg from 'pg';

export async function adminQuery(url: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4_000 });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}
