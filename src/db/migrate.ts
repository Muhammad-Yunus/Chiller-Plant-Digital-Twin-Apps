import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const host = process.env.SQL_HOST;
  const database = process.env.SQL_DB_NAME;
  const user = process.env.SQL_ADMIN_USER || process.env.SQL_USER;
  const password = process.env.SQL_ADMIN_PASSWORD || process.env.SQL_PASSWORD;

  if (!host || !database || !user || !password) {
    throw new Error(
      'SQL_HOST, SQL_DB_NAME, SQL_ADMIN_USER, and SQL_ADMIN_PASSWORD must be set.',
    );
  }

  const useSsl = process.env.SQL_SSL === 'true';
  const adminPool = new Pool({
    host,
    port: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
    database,
    user,
    password,
    ssl: useSsl
      ? { rejectUnauthorized: process.env.SQL_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
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
