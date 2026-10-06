import { type Connection, PublicKey } from '@solana/web3.js';

export const METAPLEX_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/** Metaplex `Key::MetadataV1`. */
const METADATA_V1 = 4;
const MAX_NAME_BYTES = 32;
const MAX_SYMBOL_BYTES = 10;
const MAX_URI_BYTES = 200;
const CREATOR_BYTES = 34;

/** On-chain Metaplex metadata of a mint (API-06); strings have their NUL padding trimmed. */
export interface TokenMetadata {
  /** The metadata PDA the fields were read from. */
  address: string;
  updateAuthority: string;
  name: string;
  symbol: string;
  uri: string;
  /** Null when the account ends before the flag (truncated legacy layout). */
  isMutable: boolean | null;
}

export function metadataAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID,
  )[0];
}

class Reader {
  offset = 0;
  constructor(private readonly data: Buffer) {}

  has(n: number): boolean {
    return this.offset + n <= this.data.length;
  }

  u8(): number | null {
    if (!this.has(1)) return null;
    return this.data.readUInt8(this.offset++);
  }

  u32(): number | null {
    if (!this.has(4)) return null;
    const value = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  key(): PublicKey | null {
    if (!this.has(32)) return null;
    const key = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return key;
  }

  string(max: number): string | null {
    const len = this.u32();
    if (len === null || len > max || !this.has(len)) return null;
    const text = this.data.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return text.replace(/\0+$/, '');
  }

  skip(n: number): boolean {
    if (!this.has(n)) return false;
    this.offset += n;
    return true;
  }
}

/** Decodes a `MetadataV1` account for `mint`; null when the bytes are not one. */
export function decodeMetadata(data: Uint8Array, mint: PublicKey): TokenMetadata | null {
  const r = new Reader(Buffer.from(data));
  if (r.u8() !== METADATA_V1) return null;
  const updateAuthority = r.key();
  const recordedMint = r.key();
  if (!updateAuthority || !recordedMint?.equals(mint)) return null;
  const name = r.string(MAX_NAME_BYTES);
  const symbol = r.string(MAX_SYMBOL_BYTES);
  const uri = r.string(MAX_URI_BYTES);
  if (name === null || symbol === null || uri === null) return null;

  let isMutable: boolean | null = null;
  // seller_fee_basis_points: u16, creators: Option<Vec<Creator>>, primary_sale_happened, is_mutable.
  if (r.skip(2)) {
    const hasCreators = r.u8();
    const creators = hasCreators === 1 ? r.u32() : 0;
    if (
      hasCreators !== null &&
      creators !== null &&
      r.skip(creators * CREATOR_BYTES) &&
      r.skip(1)
    ) {
      const flag = r.u8();
      isMutable = flag === null ? null : flag !== 0;
    }
  }
  return {
    address: metadataAddress(mint).toBase58(),
    updateAuthority: updateAuthority.toBase58(),
    name,
    symbol,
    uri,
    isMutable,
  };
}

/** Reads the mint's metadata PDA; null when absent, not owned by Metaplex, or undecodable. */
export async function readTokenMetadata(
  connection: Pick<Connection, 'getAccountInfo'>,
  mint: PublicKey,
): Promise<TokenMetadata | null> {
  const account = await connection.getAccountInfo(metadataAddress(mint));
  if (!account?.owner.equals(METAPLEX_METADATA_PROGRAM_ID)) return null;
  return decodeMetadata(account.data, mint);
}
