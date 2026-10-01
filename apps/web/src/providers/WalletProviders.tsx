import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { useMemo, type ReactNode } from 'react';

import '@solana/wallet-adapter-react-ui/styles.css';

import { env } from '../env';

const NETWORK =
  env.VITE_CLUSTER === 'devnet' ? WalletAdapterNetwork.Devnet : WalletAdapterNetwork.Mainnet;

/**
 * Phantom and Solflare are registered explicitly; Wallet Standard wallets
 * (Backpack and others) are detected by `WalletProvider` on its own.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: NETWORK })],
    [],
  );

  return (
    <ConnectionProvider endpoint={env.VITE_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
