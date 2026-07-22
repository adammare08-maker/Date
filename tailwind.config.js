/** @type {import('tailwindcss').Config} */
module.exports = {
  // Fichiers scannés pour ne garder que les classes réellement utilisées.
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#FFF1F4', 100: '#FFE0E7', 200: '#FFC5D2', 300: '#FF9DB4', 400: '#FF6B8E',
          500: '#FF3D6E', 600: '#ED1F55', 700: '#C81147', 800: '#A61242', 900: '#8C143E',
        },
        ember: { 400: '#FF9E6B', 500: '#FF7A59', 600: '#F25C3B' },
        ink: { 900: '#160D12', 700: '#2E2028', 500: '#5C4A54', 300: '#8B7681', 200: '#B9A7B0' },
      },
      boxShadow: {
        soft: '0 1px 2px rgba(22,13,18,.04), 0 8px 24px -8px rgba(22,13,18,.10)',
        lift: '0 2px 4px rgba(22,13,18,.04), 0 18px 48px -16px rgba(22,13,18,.18)',
        glow: '0 8px 28px -6px rgba(255,61,110,.45)',
        glowlg: '0 14px 40px -8px rgba(255,61,110,.55)',
      },
      borderRadius: { '4xl': '2rem' },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(40px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        popIn: {
          '0%': { opacity: '0', transform: 'scale(.94)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        floaty: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-9px)' },
        },
        beat: {
          '0%,100%': { transform: 'scale(1)' },
          '45%': { transform: 'scale(1.16)' },
        },
      },
      animation: {
        fadeUp: 'fadeUp .45s cubic-bezier(.22,.9,.28,1) both',
        slideUp: 'slideUp .38s cubic-bezier(.22,.9,.28,1) both',
        popIn: 'popIn .32s cubic-bezier(.22,.9,.28,1) both',
        floaty: 'floaty 6s ease-in-out infinite',
        beat: 'beat 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
