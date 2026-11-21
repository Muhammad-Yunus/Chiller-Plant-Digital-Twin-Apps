import { describe, expect, it } from 'vitest';
import { isNewerReading } from '../src/db/plantRepository.ts';
import {
  generateEdgeSecret,
  hashEdgeSecret,
  verifyEdgeSecret,
} from '../src/lib/edgeCrypto.ts';
import { sanitizeMeta } from '../src/lib/logger.ts';

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
