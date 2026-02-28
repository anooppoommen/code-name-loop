/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        shimmer: 'shimmer 2.5s linear infinite',
        googleStatus: 'shimmer 2s linear infinite, googleColors 3s ease-in-out infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% center' },
          '100%': { backgroundPosition: '-200% center' },
        },
        googleColors: {
          '0%, 100%': { backgroundColor: '#8ab4f8' },
          '25%': { backgroundColor: '#f28b82' },
          '50%': { backgroundColor: '#fde293' },
          '75%': { backgroundColor: '#81c995' },
        },
      },
    },
  },
  plugins: [],
};
