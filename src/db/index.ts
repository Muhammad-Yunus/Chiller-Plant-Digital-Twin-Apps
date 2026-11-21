import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { resolveDbConnection } from './pgConfig.ts';
import * as schema from './schema.ts';

dotenv.config({ override: true });

declare global {
  var _postgresPool: Pool | undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    const conn = resolveDbConnection({ admin: false });
    const config: PoolConfig = {
      ...(conn.connectionString
        ? { connectionString: conn.connectionString }
        : {
            host: conn.host,
            port: conn.port,
            user: conn.user,
            password: conn.password,
            database: conn.database,
          }),
      ssl: conn.ssl || undefined,
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
