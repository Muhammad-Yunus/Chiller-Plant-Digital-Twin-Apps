const REDACT_KEYS = new Set([
  'authorization',
  'x-edge-secret',
  'secret',
  'token',
  'password',
  'secrethash',
  'rawsecret',
]);

function redactValue(key: string, value: unknown): unknown {
  if (REDACT_KEYS.has(key.toLowerCase())) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'object' && item !== null ? sanitizeMeta(item as Record<string, unknown>) : item,
    );
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeMeta(value as Record<string, unknown>);
  }
  return value;
}

export function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

export type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(
  level: LogLevel,
  event: string,
  meta: Record<string, unknown> = {},
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeMeta(meta),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
