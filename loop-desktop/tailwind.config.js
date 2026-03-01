/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        loop: {
          50: '#f2f2f2',
          100: '#e6e6e6',
          200: '#d3d3d3',
          300: '#bdbdbd',
          400: '#9c9c9c',
          500: '#777777',
          600: '#313131',
          700: '#242424',
          800: '#181818',
          900: '#101010',
          950: '#080808',
        },
      },
      backgroundColor: {
        'loop-canvas': '#080808',
        'loop-surface': '#101010',
        'loop-elevated': '#181818',
        'loop-muted': '#242424',
        'loop-subtle': '#313131',
      },
      textColor: {
        'loop-primary': '#f2f2f2',
        'loop-secondary': '#e6e6e6',
        'loop-muted': '#bdbdbd',
        'loop-subtle': '#9c9c9c',
        'loop-inverse': '#080808',
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        shimmer: 'shimmer 2.5s linear infinite',
        googleStatus: 'shimmer 2s linear infinite, googleColors 3s ease-in-out infinite',
        googleText: 'googleTextColors 3s ease-in-out infinite',
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
        googleTextColors: {
          '0%, 100%': { color: '#8ab4f8' },
          '25%': { color: '#f28b82' },
          '50%': { color: '#fde293' },
          '75%': { color: '#81c995' },
        },
      },
    },
  },
  plugins: [],
};
