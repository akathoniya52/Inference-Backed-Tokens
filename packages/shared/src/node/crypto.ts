import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX_KEY = /^[0-9a-f]{64}$/i;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=?$/;

function masterKeyBytes(masterKey: string): Buffer {
  if (HEX_KEY.test(masterKey)) return Buffer.from(masterKey, 'hex');
  if (BASE64_KEY.test(masterKey)) return Buffer.from(masterKey, 'base64');
  throw new Error('master key must be 32 bytes, as 64 hex chars or base64');
}

// Ciphertext layout (L297): base64(iv[12] | authTag[16] | data), with a random IV per call.
export function encrypt(plaintext: string, masterKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKeyBytes(masterKey), iv, {
    authTagLength: TAG_BYTES,
  });
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(ciphertext: string, masterKey: string): string {
  const key = masterKeyBytes(masterKey);
  const packed = Buffer.from(ciphertext, 'base64');
  if (packed.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext is too short');
  const decipher = createDecipheriv(ALGORITHM, key, packed.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const data = packed.subarray(IV_BYTES + TAG_BYTES);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
