import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { CodeBlock } from '../components/CodeBlock';
import { env } from '../env';

const API_URL = env.VITE_API_URL.replace(/\/+$/, '');
const BASE_URL = `${API_URL}/v1`;
const EXAMPLE_MODEL = 'llama-3.1-8b-fast';

const JS_SNIPPET = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE_URL}',
  apiKey: 'ibt_…', // Dashboard → API keys
});

const completion = await client.chat.completions.create({
  model: '${EXAMPLE_MODEL}',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 256,
});

console.log(completion.choices[0].message.content);`;

const PYTHON_SNIPPET = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="ibt_…",  # Dashboard → API keys
)

completion = client.chat.completions.create(
    model="${EXAMPLE_MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
    max_tokens=256,
)

print(completion.choices[0].message.content)`;

const CURL_SNIPPET = `curl -i ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer $IBT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "model": "${EXAMPLE_MODEL}",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 256
  }'`;

const MODELS_SNIPPET = `curl ${BASE_URL}/models \\
  -H "Authorization: Bearer $IBT_API_KEY"`;

const RESPONSE_HEADERS = [
  [
    'X-Request-Id',
    'Echoes your X-Request-Id or a generated one. Quote it when reporting a problem.',
  ],
  ['X-Cost-Usdc', 'What this request cost, in USDC, after any holder discount.'],
  ['X-Balance-Usdc', 'Your credit balance after the charge.'],
  ['X-Discount-Bps', 'Holder discount applied, in basis points (1000 = 10%).'],
] as const;

// Spec L417–426. No error response is ever billed.
const GATEWAY_ERRORS = [
  [400, 'invalid_request', 'The body fails validation (OpenAI chat completions schema).'],
  [401, 'invalid_api_key', 'The key is missing, unknown or revoked.'],
  [
    402,
    'insufficient_credits',
    'Balance is below the hold estimate; the body includes shortfallUsdc.',
  ],
  [404, 'model_not_found', 'No active model has this slug.'],
  [429, 'rate_limited', 'More than 60 requests per minute on one key.'],
  [502, 'upstream_error', 'The provider returned a non-2xx status or a malformed body.'],
  [503, 'model_paused', 'Health checks paused the model.'],
  [504, 'upstream_timeout', 'No first byte within 30 s, or the request ran past 300 s.'],
] as const;

const SPLIT = [
  [
    'Provider',
    '70%',
    'USDC transfer from the treasury to the provider wallet once at least 1 USDC has accrued.',
  ],
  [
    'Liquidity',
    '20%',
    "Buys the model's token on its bonding curve; after graduation, added to a permanently locked DAMM v2 position.",
  ],
  ['Platform', '10%', 'Stays in the treasury. No transaction.'],
] as const;

const SECTIONS = [
  ['quickstart', 'Quickstart'],
  ['sdk', 'OpenAI SDK'],
  ['curl', 'curl'],
  ['streaming', 'Streaming'],
  ['headers', 'Response headers'],
  ['errors', 'Errors'],
  ['revenue', 'Where the money goes'],
] as const;

const TABLE = 'w-full text-left text-sm';
const TH = 'px-4 py-3 font-mono text-xs font-normal uppercase tracking-label text-ink-400';
const TD = 'border-t border-ink-800 px-4 py-3 align-top';
const INLINE_CODE = 'rounded-sm bg-ink-900 px-1.5 py-0.5 font-mono text-sm text-ink-50';

function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-24 border-t border-ink-800 pt-10"
    >
      <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight text-ink-50">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-ink-200">{children}</div>
    </section>
  );
}

function TableFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded-sm border border-ink-800">{children}</div>;
}

export function DocsPage() {
  return (
    <section>
      <h1 className="page-title">API quickstart</h1>
      <p className="page-lede">
        Point the OpenAI SDK at the gateway by changing its baseURL and API key.
      </p>

      <div className="mt-10 grid gap-12 lg:grid-cols-4">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-24 space-y-2 border-l border-ink-800 font-mono text-xs uppercase tracking-label">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="-ml-px block border-l border-transparent pl-4 text-ink-400 transition-colors hover:border-accent hover:text-ink-50"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-12 lg:col-span-3">
          <DocSection id="quickstart" title="Quickstart">
            <ol aria-label="Quickstart steps" className="grid gap-4 md:grid-cols-3">
              <li className="rounded-sm border border-ink-800 bg-ink-900/60 p-5">
                <span className="font-mono text-xs text-accent">01</span>
                <h3 className="mt-2 font-medium text-ink-50">Sign in with your wallet</h3>
                <p className="mt-2 text-sm text-ink-400">
                  Connect Phantom or Solflare and sign a one-time message. Signing is free and sends
                  no transaction.
                </p>
              </li>
              <li className="rounded-sm border border-ink-800 bg-ink-900/60 p-5">
                <span className="font-mono text-xs text-accent">02</span>
                <h3 className="mt-2 font-medium text-ink-50">Deposit USDC</h3>
                <p className="mt-2 text-sm text-ink-400">
                  On the{' '}
                  <Link
                    to="/dashboard"
                    className="text-ink-50 underline decoration-ink-600 underline-offset-4 hover:text-accent"
                  >
                    Dashboard
                  </Link>
                  , send USDC to the treasury. Your deposit reference rides along as the memo, and
                  the balance is credited once the transfer is finalized.
                </p>
              </li>
              <li className="rounded-sm border border-ink-800 bg-ink-900/60 p-5">
                <span className="font-mono text-xs text-accent">03</span>
                <h3 className="mt-2 font-medium text-ink-50">Create an API key</h3>
                <p className="mt-2 text-sm text-ink-400">
                  Keys start with <code className="font-mono text-ink-200">ibt_</code> and are shown
                  once. Each key has a daily spend cap, 50 USDC by default.
                </p>
              </li>
            </ol>
          </DocSection>

          <DocSection id="sdk" title="OpenAI SDK">
            <p>
              The gateway speaks the OpenAI chat completions API. Keep your code, swap two settings:
              set <code className={INLINE_CODE}>baseURL</code> to{' '}
              <code className={INLINE_CODE}>{BASE_URL}</code> and use your{' '}
              <code className={INLINE_CODE}>ibt_</code> key. The{' '}
              <code className={INLINE_CODE}>model</code> field takes the model slug shown on
              Explore.
            </p>
            <CodeBlock title="JavaScript / TypeScript" language="ts" code={JS_SNIPPET} />
            <CodeBlock title="Python" language="python" code={PYTHON_SNIPPET} />
          </DocSection>

          <DocSection id="curl" title="curl">
            <p>
              Requests go to <code className={INLINE_CODE}>POST /v1/chat/completions</code> with the
              key as a bearer token. An <code className={INLINE_CODE}>Idempotency-Key</code> makes
              retries safe: a repeat within 24 hours returns the stored response and is never billed
              twice.
            </p>
            <CodeBlock title="curl" language="sh" code={CURL_SNIPPET} />
            <p>List active models and their prices:</p>
            <CodeBlock title="List models" language="sh" code={MODELS_SNIPPET} />
          </DocSection>

          <DocSection id="streaming" title="Streaming">
            <p className="rounded-sm border border-accent/40 bg-accent/10 p-4 text-sm text-ink-50">
              Streaming is coming soon. For now send requests without{' '}
              <code className="font-mono">stream: true</code>; the full completion arrives in one
              response with its cost in the headers.
            </p>
          </DocSection>

          <DocSection id="headers" title="Response headers">
            <p>The body is the upstream response unchanged. The gateway adds:</p>
            <TableFrame>
              <table aria-label="Response headers" className={TABLE}>
                <thead className="bg-ink-900">
                  <tr>
                    <th scope="col" className={TH}>
                      Header
                    </th>
                    <th scope="col" className={TH}>
                      Meaning
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {RESPONSE_HEADERS.map(([name, meaning]) => (
                    <tr key={name}>
                      <td className={`${TD} whitespace-nowrap font-mono text-ink-50`}>{name}</td>
                      <td className={`${TD} text-ink-200`}>{meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </DocSection>

          <DocSection id="errors" title="Errors">
            <p>
              Errors share one envelope:{' '}
              <code className={INLINE_CODE}>{'{"error": {"code", "message", "requestId"}}'}</code>.
              Failed requests are never billed.
            </p>
            <TableFrame>
              <table aria-label="Gateway errors" className={TABLE}>
                <thead className="bg-ink-900">
                  <tr>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <th scope="col" className={TH}>
                      error.code
                    </th>
                    <th scope="col" className={TH}>
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {GATEWAY_ERRORS.map(([status, code, when]) => (
                    <tr key={code}>
                      <td className={`${TD} font-mono tabular-nums text-ink-400`}>{status}</td>
                      <td className={`${TD} whitespace-nowrap font-mono text-ink-50`}>{code}</td>
                      <td className={`${TD} text-ink-200`}>{when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </DocSection>

          <DocSection id="revenue" title="Where the money goes">
            <p>
              Every hour the keeper settles the previous hour&apos;s billed revenue for each model
              and publishes every signature on the model&apos;s token page.
            </p>
            <TableFrame>
              <table aria-label="Revenue split" className={TABLE}>
                <thead className="bg-ink-900">
                  <tr>
                    <th scope="col" className={TH}>
                      Share
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Default
                    </th>
                    <th scope="col" className={TH}>
                      Destination
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {SPLIT.map(([share, pct, destination]) => (
                    <tr key={share}>
                      <td className={`${TD} text-ink-50`}>{share}</td>
                      <td className={`${TD} text-right font-mono tabular-nums text-accent`}>
                        {pct}
                      </td>
                      <td className={`${TD} text-ink-200`}>{destination}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            <p className="text-sm text-ink-400">
              Before a model launches its token the liquidity share goes to the provider (90 / 10).
              Holding at least 1,000,000 of a model&apos;s tokens in a linked wallet takes 10% off
              that model&apos;s prices, reported in{' '}
              <code className={INLINE_CODE}>X-Discount-Bps</code>.
            </p>
          </DocSection>
        </div>
      </div>
    </section>
  );
}
