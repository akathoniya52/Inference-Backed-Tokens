import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout and leaves scrolling unimplemented; `<ScrollRestoration>` calls both.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined;
}

afterEach(() => {
  cleanup();
});
