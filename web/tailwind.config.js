/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: token('base'),
        panel: token('panel'),
        raised: token('raised'),
        line: token('line'),
        ink: token('ink'),
        muted: token('muted'),
        faint: token('faint'),
        signal: token('signal'),
        run: token('accent'),
        onaccent: token('on-accent'),
        queue: token('queue'),
        done: token('done'),
        danger: token('danger'),
      },
      fontFamily: {
        display: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"Helvetica Neue"', 'system-ui', 'sans-serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Helvetica Neue"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 0.5px 1px rgb(0 0 0 / 0.06), 0 2px 8px rgb(0 0 0 / 0.05)',
        sheet: '0 20px 60px rgb(0 0 0 / 0.25), 0 0 0 0.5px rgb(0 0 0 / 0.08)',
        bar: '0 8px 30px rgb(0 0 0 / 0.14), 0 0 0 0.5px rgb(0 0 0 / 0.06)',
      },
      borderRadius: { card: '14px', sheet: '20px' },
    },
  },
  plugins: [],
};
