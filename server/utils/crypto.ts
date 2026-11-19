import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifySecret(secret: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, originalHex] = parts;
  const originalBuf = Buffer.from(originalHex, 'hex');
  const derivedBuf = crypto.scryptSync(secret, salt, originalBuf.length);
  if (derivedBuf.length !== originalBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedBuf, originalBuf);
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
