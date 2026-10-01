import { LaunchWizard } from '../components/LaunchWizard';
import { WalletGate } from '../components/WalletGate';

export function LaunchPage() {
  return (
    <section>
      <h1 className="page-title">Launch a model</h1>
      <p className="page-lede">
        Register an OpenAI-compatible endpoint, set its prices and launch its token.
      </p>
      <WalletGate purpose="register a model and launch its token">
        <LaunchWizard />
      </WalletGate>
    </section>
  );
}
