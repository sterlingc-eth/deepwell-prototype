import type { Config } from 'tailwindcss';

/**
 * DeepWell design tokens.
 *
 * Brand (from the logo): forest green, navy, a single brass accent.
 * Neutrals are green-biased so the greys sit naturally next to the forest.
 * Semantic roles (bg / surface / text / border ...) are CSS variables set in
 * index.css so light (office) and field (dark, high-contrast) themes share
 * one component vocabulary.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      screens: { xs: '420px' },
      colors: {
        forest: {
          50: '#EEF4F0',
          100: '#D8E6DC',
          200: '#B3CDBB',
          300: '#86AE93',
          400: '#5A8C6C',
          500: '#3A6B4D',
          600: '#245239',
          700: '#163C2C',
          800: '#10291F',
          900: '#0A1B14',
          950: '#05100B',
        },
        navy: {
          50: '#EDF2F8',
          100: '#D6E1EE',
          200: '#ADC3DD',
          300: '#7FA0C6',
          400: '#4F7BAB',
          500: '#2B5A8C',
          600: '#123D6B',
          700: '#0E3057',
          800: '#0A2341',
          900: '#06172C',
          950: '#030D1A',
        },
        brass: {
          50: '#FBF6EE',
          100: '#F4E8D3',
          200: '#E8D1A8',
          300: '#D9B57A',
          400: '#C99C5C',
          500: '#B98A4E',
          600: '#9B7039',
          700: '#7A572C',
          800: '#593F20',
          900: '#3A2914',
        },
        stone: {
          0: '#FFFFFF',
          50: '#F6F8F6',
          100: '#ECF0ED',
          200: '#DCE3DE',
          300: '#C2CCC5',
          400: '#97A59B',
          500: '#6E7C72',
          600: '#525E56',
          700: '#3C463F',
          800: '#29312C',
          900: '#181E1A',
          950: '#0D110E',
        },
        // Semantic roles — values live in index.css (light + .dark)
        bg: 'var(--dw-bg)',
        surface: 'var(--dw-surface)',
        'surface-2': 'var(--dw-surface-2)',
        ink: 'var(--dw-ink)',
        'ink-2': 'var(--dw-ink-2)',
        'ink-3': 'var(--dw-ink-3)',
        line: 'var(--dw-line)',
        'line-2': 'var(--dw-line-2)',
        accent: 'var(--dw-accent)',
        'accent-ink': 'var(--dw-accent-ink)',
        focus: 'var(--dw-focus)',
        // Status (icon + text always accompany colour)
        ok: { DEFAULT: '#1E7A46', bg: '#E3F3E9', ink: '#0F4A29' },
        warn: { DEFAULT: '#9A6200', bg: '#FBEFD3', ink: '#5C3A00' },
        bad: { DEFAULT: '#B42318', bg: '#FDE8E6', ink: '#7A1810' },
        info: { DEFAULT: '#123D6B', bg: '#E6EEF7', ink: '#0A2341' },
      },
      fontFamily: {
        display: ['Newsreader', 'Georgia', 'Times New Roman', 'serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Type scale from DESIGN_SYSTEM_SPEC, with field-mode sizes added
        caption: ['12px', { lineHeight: '16px' }],
        label: ['12px', { lineHeight: '18px', letterSpacing: '0.02em' }],
        body: ['14px', { lineHeight: '22px' }],
        'body-lg': ['16px', { lineHeight: '24px' }],
        'body-xl': ['18px', { lineHeight: '28px' }],
        h4: ['16px', { lineHeight: '24px' }],
        h3: ['18px', { lineHeight: '28px' }],
        h2: ['24px', { lineHeight: '32px' }],
        h1: ['32px', { lineHeight: '40px' }],
        display: ['40px', { lineHeight: '46px', letterSpacing: '-0.01em' }],
        'display-lg': ['52px', { lineHeight: '56px', letterSpacing: '-0.015em' }],
        data: ['13px', { lineHeight: '20px', letterSpacing: '0.03em' }],
      },
      spacing: {
        touch: '48px',
      },
      borderRadius: {
        DEFAULT: '8px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(13, 17, 14, 0.06), 0 1px 3px rgba(13, 17, 14, 0.04)',
        lift: '0 8px 20px rgba(13, 17, 14, 0.12)',
        modal: '0 10px 40px rgba(13, 17, 14, 0.24)',
      },
      maxWidth: {
        content: '1200px',
        ask: '760px',
      },
      transitionDuration: {
        quick: '200ms',
        page: '300ms',
      },
      transitionTimingFunction: {
        enter: 'cubic-bezier(0, 0, 0.2, 1)',
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        rise: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 200ms cubic-bezier(0, 0, 0.2, 1) both',
        rise: 'rise 240ms cubic-bezier(0, 0, 0.2, 1) both',
      },
    },
  },
  plugins: [],
} satisfies Config;
