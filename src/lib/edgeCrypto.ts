import crypto from 'crypto';

const KEY_LEN = 64;

export function generateEdgeSecret(): string {
  return `cp_edge_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashEdgeSecret(secret: string, salt?: string): { hash: string; salt: string } {
  const effectiveSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, effectiveSalt, KEY_LEN);
  return {
    hash: derived.toString('hex'),
    salt: effectiveSalt,
  };
}

export function verifyEdgeSecret(secret: string, expectedHash: string, salt: string): boolean {
  if (!secret || !expectedHash || !salt) return false;
  const derived = crypto.scryptSync(secret, salt, KEY_LEN);
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuf);
}
