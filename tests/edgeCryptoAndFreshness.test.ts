import { describe, expect, it } from 'vitest';
import { resolveDbConnection } from '../src/db/pgConfig.ts';
import { computePayloadHash, isNewerReading } from '../src/db/plantRepository.ts';
import {
  generateEdgeSecret,
  hashEdgeSecret,
  verifyEdgeSecret,
} from '../src/lib/edgeCrypto.ts';
import { sanitizeMeta } from '../src/lib/logger.ts';
import type { TelemetryIngestPayload } from '../src/validation/telemetrySchemas.ts';

describe('edge gateway credential hashing', () => {
  it('verifies valid generated secrets and rejects invalid secrets', () => {
    const secret = generateEdgeSecret();
    expect(secret.startsWith('cp_edge_')).toBe(true);

    const { hash, salt } = hashEdgeSecret(secret);
    expect(verifyEdgeSecret(secret, hash, salt)).toBe(true);
    expect(verifyEdgeSecret(`${secret}-tampered`, hash, salt)).toBe(false);
    expect(verifyEdgeSecret('', hash, salt)).toBe(false);
  });
});

describe('out-of-order telemetry guard (isNewerReading)', () => {
  const t1 = new Date('2026-01-01T10:00:00.000Z');
  const t2 = new Date('2026-01-01T10:00:05.000Z');

  it('accepts reading when no current state exists', () => {
    expect(isNewerReading(t1, 1, null, null)).toBe(true);
  });

  it('accepts strictly newer sourceTimestamp and rejects stale older sourceTimestamp', () => {
    expect(isNewerReading(t2, 1, t1, 999)).toBe(true);
    expect(isNewerReading(t1, 999, t2, 1)).toBe(false);
  });

  it('uses sequenceNumber as tiebreaker for equal timestamps', () => {
    expect(isNewerReading(t2, 12, t2, 11)).toBe(true);
    expect(isNewerReading(t2, 11, t2, 11)).toBe(false);
    expect(isNewerReading(t2, 10, t2, 11)).toBe(false);
  });
});

describe('structured logger redaction', () => {
  it('redacts sensitive secrets, tokens, and headers recursively', () => {
    const sanitized = sanitizeMeta({
      requestId: 'req-123',
      authorization: 'Bearer eyJ...',
      nested: {
        'x-edge-secret': 'cp_edge_secret_value',
        plantCode: 'CENTRAL_PLANT_01',
      },
    });
    expect(sanitized.requestId).toBe('req-123');
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect((sanitized.nested as Record<string, unknown>)['x-edge-secret']).toBe(
      '[REDACTED]',
    );
    expect((sanitized.nested as Record<string, unknown>).plantCode).toBe(
      'CENTRAL_PLANT_01',
    );
  });
});

describe('Supabase pooler TLS & canonical payload hash', () => {
  it('enforces rejectUnauthorized=true by default for SUPABASE_DB_URL unless explicitly disabled', () => {
    const prevUrl = process.env.SUPABASE_DB_URL;
    const prevReject = process.env.SQL_SSL_REJECT_UNAUTHORIZED;
    try {
      process.env.SUPABASE_DB_URL = 'postgresql://postgres.ref:pw@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres';
      delete process.env.SQL_SSL_REJECT_UNAUTHORIZED;
      const secureConn = resolveDbConnection();
      expect(secureConn.connectionString).toContain('pooler.supabase.com:6543');
      expect(secureConn.ssl).toEqual({ rejectUnauthorized: true });

      process.env.SQL_SSL_REJECT_UNAUTHORIZED = 'false';
      const optOutConn = resolveDbConnection();
      expect(optOutConn.ssl).toEqual({ rejectUnauthorized: false });
    } finally {
      if (prevUrl === undefined) delete process.env.SUPABASE_DB_URL;
      else process.env.SUPABASE_DB_URL = prevUrl;
      if (prevReject === undefined) delete process.env.SQL_SSL_REJECT_UNAUTHORIZED;
      else process.env.SQL_SSL_REJECT_UNAUTHORIZED = prevReject;
    }
  });

  it('produces identical SHA-256 payloadHash regardless of key insertion order and detects value changes', () => {
    const p1: TelemetryIngestPayload = {
      plantCode: 'CENTRAL_PLANT_01',
      edgeDeviceId: 'gw-1',
      sequenceNumber: 1,
      payloadVersion: '1.0.0',
      observedAt: '2026-11-21T12:00:00.000Z',
      scenario: 'Steady State',
      quality: 'GOOD',
      kpis: {
        coolingLoadMw: 9.2,
        totalPowerMw: 1.9,
        systemCop: 4.8,
        wetBulbC: 27,
        chwSupplyC: 6.9,
        chwReturnC: 11.7,
        deltaTK: 4.8,
        cwSupplyC: 31.5,
        towerApproachK: 4.5,
        chillersOn: 3,
      },
      devices: [{ id: 'ch-1', status: 'RUNNING', quality: 'GOOD', loadPct: 88, metrics: { a: 1, b: 2 } }],
    };

    const p2: TelemetryIngestPayload = {
      ...p1,
      devices: [{ id: 'ch-1', status: 'RUNNING', quality: 'GOOD', loadPct: 88, metrics: { b: 2, a: 1 } }],
    };

    const p3: TelemetryIngestPayload = {
      ...p1,
      devices: [{ id: 'ch-1', status: 'RUNNING', quality: 'GOOD', loadPct: 89, metrics: { a: 1, b: 2 } }],
    };

    expect(computePayloadHash(p1)).toBe(computePayloadHash(p2));
    expect(computePayloadHash(p1)).not.toBe(computePayloadHash(p3));
  });
});
