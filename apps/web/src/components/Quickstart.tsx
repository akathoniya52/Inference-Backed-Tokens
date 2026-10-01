import { env } from '../env';

const PLACEHOLDER_KEY = 'ibt_YOUR_API_KEY';

export function Quickstart({ modelSlug = 'your-model-slug' }: { modelSlug?: string }) {
  const baseUrl = `${env.VITE_API_URL.replace(/\/+$/, '')}/v1`;
  const curl = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${PLACEHOLDER_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${modelSlug}", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 256}'`;
  const js = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${baseUrl}', apiKey: '${PLACEHOLDER_KEY}' });

const completion = await client.chat.completions.create({
  model: '${modelSlug}',
  messages: [{ role: 'user', content: 'Hello' }],
});`;

  return (
    <section
      aria-labelledby="quickstart-title"
      className="rounded-sm border border-ink-800 bg-ink-900 p-6"
    >
      <h2 id="quickstart-title" className="text-lg font-semibold tracking-tight text-ink-50">
        Quickstart
      </h2>
      <p className="mt-1 text-sm text-ink-400">
        OpenAI-compatible: point any OpenAI SDK at <span className="font-mono">{baseUrl}</span> and
        use a key from above.
      </p>
      {[
        ['curl', curl],
        ['JavaScript', js],
      ].map(([label, code]) => (
        <figure key={label} className="mt-4">
          <figcaption className="font-mono text-xs uppercase tracking-label text-ink-600">
            {label}
          </figcaption>
          <pre className="mt-2 overflow-x-auto rounded-sm border border-ink-800 bg-ink-950 p-4 font-mono text-xs leading-relaxed text-ink-200">
            <code>{code}</code>
          </pre>
        </figure>
      ))}
    </section>
  );
}
