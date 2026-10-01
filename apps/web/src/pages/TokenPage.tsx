import { useParams } from 'react-router-dom';

export function TokenPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  return (
    <section>
      <h1 className="page-title">
        Token <span className="font-mono text-accent">{slug}</span>
      </h1>
      <p className="page-lede">Curve progress, trading and the settlement ledger for this model.</p>
    </section>
  );
}
