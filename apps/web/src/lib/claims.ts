import { CpAmm, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient, U64_MAX } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Transaction, type Connection, type PublicKey } from '@solana/web3.js';

// Fee claims (spec L125, L498). The provider is the DBC pool creator and owns
// a permanently locked DAMM v2 position after migration; the treasury wallet
// is the config's `feeClaimer` and collects the partner share of curve fees.

export type ClaimRole = 'creator' | 'partner';

export function resolveClaimRole(
  wallet: string,
  providerWallet: string,
  feeClaimer: string | null,
): ClaimRole | null {
  if (wallet === providerWallet) return 'creator';
  if (feeClaimer !== null && wallet === feeClaimer) return 'partner';
  return null;
}

export async function fetchFeeClaimer(
  connection: Connection,
  dbcPool: PublicKey,
): Promise<string | null> {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = await client.state.getPool(dbcPool);
  if (!pool) return null;
  const config = await client.state.getPoolConfig(pool.poolState.config);
  return config ? config.feeClaimer.toBase58() : null;
}

export interface ClaimInput {
  role: ClaimRole;
  owner: PublicKey;
  dbcPool: PublicKey;
  /** Set once the token graduated; the creator also claims its LP position fees. */
  dammPool: PublicKey | null;
}

async function positionFeeTransactions(
  connection: Connection,
  owner: PublicKey,
  pool: PublicKey,
): Promise<Transaction[]> {
  const client = new CpAmm(connection);
  const [state, positions] = await Promise.all([
    client.fetchPoolState(pool),
    client.getUserPositionByPool(pool, owner),
  ]);
  return Promise.all(
    positions.map(({ position, positionNftAccount }) =>
      client.claimPositionFee({
        owner,
        pool,
        position,
        positionNftAccount,
        tokenAMint: state.tokenAMint,
        tokenBMint: state.tokenBMint,
        tokenAVault: state.tokenAVault,
        tokenBVault: state.tokenBVault,
        tokenAProgram: getTokenProgram(state.tokenAFlag),
        tokenBProgram: getTokenProgram(state.tokenBFlag),
      }),
    ),
  );
}

/**
 * One transaction with every claim the role is entitled to. Max amounts are
 * `U64_MAX` so the program pays out whatever has accrued.
 */
export async function buildClaimTransaction(
  connection: Connection,
  { role, owner, dbcPool, dammPool }: ClaimInput,
): Promise<Transaction> {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const amounts = { payer: owner, pool: dbcPool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX };

  if (role === 'partner') {
    return dbc.partner.claimPartnerTradingFee({ feeClaimer: owner, ...amounts });
  }

  const parts = await Promise.all([
    dbc.creator.claimCreatorTradingFee({ creator: owner, ...amounts }),
    ...(dammPool === null ? [] : [positionFeeTransactions(connection, owner, dammPool)]),
  ]);
  return new Transaction().add(...parts.flat().flatMap((tx) => tx.instructions));
}
