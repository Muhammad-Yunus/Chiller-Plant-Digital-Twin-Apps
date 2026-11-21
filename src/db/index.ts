import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

function buildSslConfig(): PoolConfig['ssl'] {
  if (process.env.SQL_SSL === 'true') {
    return {
      rejectUnauthorized: process.env.SQL_SSL_REJECT_UNAUTHORIZED !== 'false',
    };
  }
  return undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    const config: PoolConfig = {
      host: process.env.SQL_HOST,
      port: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      ssl: buildSslConfig(),
      max: Number(process.env.SQL_POOL_MAX ?? 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    };
    global._postgresPool = new Pool(config);

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db = drizzle(pool, { schema });

export async function closePool(): Promise<void> {
  if (global._postgresPool) {
    const target = global._postgresPool;
    global._postgresPool = undefined;
    await target.end();
  }
}
