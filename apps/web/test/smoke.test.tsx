import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App';

describe('@ibt/web', () => {
  it('renders the app title', () => {
    expect(renderToStaticMarkup(<App />)).toContain('Inference-Backed Tokens');
  });
});
