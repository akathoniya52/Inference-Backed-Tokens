// Bitcoin-alphabet base58; `bs58` is not an api dependency.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = ALPHABET.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Returns `null` for characters outside the alphabet. */
export function base58Decode(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  let n = 0n;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) return null;
    n = n * 58n + digit;
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}
