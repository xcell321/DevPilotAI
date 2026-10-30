/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: 'var(--color-bg)',
        panel: 'var(--color-panel)',
        'panel-2': 'var(--color-panel-2)',
        primary: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          soft: 'var(--color-primary-soft)',
        },
        brass: {
          DEFAULT: 'var(--color-brass)',
          hover: 'var(--color-brass-hover)',
          soft: 'var(--color-brass-soft)',
        },
        ok: {
          DEFAULT: 'var(--color-ok)',
          soft: 'var(--color-ok-soft)',
        },
        warn: {
          DEFAULT: 'var(--color-warn)',
          soft: 'var(--color-warn-soft)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          soft: 'var(--color-danger-soft)',
        },
        ink: 'var(--color-text)',
        muted: 'var(--color-muted)',
        line: 'var(--color-border)',
        lineStrong: 'var(--color-border-strong)',
        hover: 'var(--color-hover)',
      },
      borderRadius: {
        panel: 'var(--radius-panel)',
      },
      fontFamily: {
        display: 'var(--font-display)',
        serif: 'var(--font-serif)',
        mono: 'var(--font-mono)',
      },
    },
  },
  plugins: [],
};
