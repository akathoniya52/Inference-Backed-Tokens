import type { Config } from 'tailwindcss';

// Colours are RGB channel triplets defined in src/index.css so alpha modifiers work.
const channel = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: channel('ink-950'),
          900: channel('ink-900'),
          800: channel('ink-800'),
          600: channel('ink-600'),
          400: channel('ink-400'),
          200: channel('ink-200'),
          50: channel('ink-50'),
        },
        accent: {
          DEFAULT: channel('accent'),
          strong: channel('accent-strong'),
          fg: channel('accent-fg'),
        },
        positive: channel('positive'),
        negative: channel('negative'),
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        label: '0.14em',
      },
      maxWidth: {
        shell: '72rem',
      },
    },
  },
  plugins: [],
} satisfies Config;
