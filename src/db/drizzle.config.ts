import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import { resolveDbConnection } from './pgConfig.ts';

dotenv.config({ override: true });

const conn = resolveDbConnection({ admin: true });

if (
  !conn.connectionString &&
  (!conn.host || !conn.database || !conn.user || !conn.password)
) {
  throw new Error(
    'Set SUPABASE_DB_URL / DATABASE_URL or SQL_HOST, SQL_DB_NAME, SQL_ADMIN_USER, and SQL_ADMIN_PASSWORD.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['public'],
  dbCredentials: conn.connectionString
    ? {
        url: conn.connectionString,
        ssl: conn.ssl || false,
      }
    : {
        host: conn.host!,
        port: conn.port,
        user: conn.user!,
        password: conn.password!,
        database: conn.database!,
        ssl: conn.ssl || false,
      },
  verbose: true,
});
