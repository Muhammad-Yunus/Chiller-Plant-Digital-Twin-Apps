import fs from 'fs';
import path from 'path';
import type { PoolConfig } from 'pg';

export interface ResolvedDbConnection {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: Exclude<PoolConfig['ssl'], boolean> | false;
}

function resolveSslCa(): string | undefined {
  const rawCa = process.env.SQL_SSL_CA?.trim();
  if (!rawCa) return undefined;
  if (rawCa.includes('BEGIN CERTIFICATE')) {
    return rawCa.replace(/\\n/g, '\n');
  }
  const resolvedPath = path.isAbsolute(rawCa) ? rawCa : path.resolve(process.cwd(), rawCa);
  if (fs.existsSync(resolvedPath)) {
    return fs.readFileSync(resolvedPath, 'utf8');
  }
  return undefined;
}

export function buildSslConfig(hasConnectionString: boolean): Exclude<PoolConfig['ssl'], boolean> | undefined {
  const sqlSsl = process.env.SQL_SSL?.trim().toLowerCase();
  const shouldUseSsl = sqlSsl === 'true' || (hasConnectionString && sqlSsl !== 'false');
  if (!shouldUseSsl) return undefined;

  const ca = resolveSslCa();
  const rejectUnauthorized = process.env.SQL_SSL_REJECT_UNAUTHORIZED !== 'false';

  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
  };
}

export function resolveDbConnection(options?: { admin?: boolean }): ResolvedDbConnection {
  const isAdmin = options?.admin ?? false;
  const url = isAdmin
    ? process.env.SUPABASE_ADMIN_DB_URL?.trim() ||
      process.env.SUPABASE_DB_URL?.trim() ||
      process.env.DATABASE_URL?.trim()
    : process.env.SUPABASE_DB_URL?.trim() || process.env.DATABASE_URL?.trim();

  if (url) {
    const ssl = buildSslConfig(true);
    return {
      connectionString: url,
      ssl: ssl ?? false,
    };
  }

  const host = process.env.SQL_HOST?.trim();
  const database = process.env.SQL_DB_NAME?.trim();
  const user = isAdmin
    ? process.env.SQL_ADMIN_USER?.trim() || process.env.SQL_USER?.trim()
    : process.env.SQL_USER?.trim();
  const password = isAdmin
    ? process.env.SQL_ADMIN_PASSWORD || process.env.SQL_PASSWORD
    : process.env.SQL_PASSWORD;
  const port = process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined;
  const ssl = buildSslConfig(false);

  return {
    host,
    port,
    database,
    user,
    password,
    ssl: ssl ?? false,
  };
}
