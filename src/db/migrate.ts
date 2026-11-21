import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { resolveDbConnection } from './pgConfig.ts';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const conn = resolveDbConnection({ admin: true });

  if (
    !conn.connectionString &&
    (!conn.host || !conn.database || !conn.user || !conn.password)
  ) {
    throw new Error(
      'Set SUPABASE_DB_URL / DATABASE_URL or SQL_HOST, SQL_DB_NAME, SQL_ADMIN_USER, and SQL_ADMIN_PASSWORD.',
    );
  }

  const adminPool = new Pool({
    ...(conn.connectionString
      ? { connectionString: conn.connectionString }
      : {
          host: conn.host,
          port: conn.port,
          database: conn.database,
          user: conn.user,
          password: conn.password,
        }),
    ssl: conn.ssl || undefined,
    max: 2,
    connectionTimeoutMillis: 15000,
  });

  try {
    const db = drizzle(adminPool);
    const migrationsFolder = path.resolve(__dirname, '../../drizzle');
    console.log(`Applying Drizzle migrations from ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log('Migrations applied cleanly.');
  } finally {
    await adminPool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
