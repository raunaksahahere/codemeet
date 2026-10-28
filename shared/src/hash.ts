import { createHash, randomBytes } from 'node:crypto';

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
