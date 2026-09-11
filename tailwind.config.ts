import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9fc',
          100: '#e0f2f9',
          200: '#bae5f3',
          300: '#7ecce8',
          400: '#41b3dd',
          500: '#1a99cf',
          600: '#0a5f7f',
          700: '#084a64',
          800: '#093c52',
          900: '#051d2c',
        },
        secondary: {
          50: '#fef5e7',
          100: '#fcebcf',
          200: '#f9d79e',
          300: '#f5c24d',
          400: '#edaa1d',
          500: '#D97706',
          600: '#b8690a',
          700: '#8f5008',
          800: '#6d3c06',
          900: '#4a250d',
        },
        accent: {
          50: '#f9fafb',
          100: '#f3f4f6',
          200: '#e5e7eb',
          300: '#d1d5db',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1f2937',
          900: '#111827',
        },
        success: '#10B981',
        warning: '#F97316',
        error: '#EF4444',
      },
      fontFamily: {
        heading: ['Inter', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['Courier New', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-up': 'slideUp 300ms ease-out',
        'cascade': 'cascade 600ms ease-out',
        'pulse-gentle': 'pulseGentle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        cascade: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pulseGentle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.8' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
