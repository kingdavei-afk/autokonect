import type { Config } from 'tailwindcss';

/**
 * Palette.
 *
 * Elle est posee ICI et nulle part ailleurs : un meme orange ne doit
 * pas exister en deux variantes dans deux composants, sinon l'écart
 * finit par se voir.
 *
 * Les couleurs sont declarees en variables CSS plutot qu'en dur pour
 * que le contraste puisse etre ajuste sans toucher aux composants.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Orange : couleur de marque, reservee aux actions principales.
        // L'utiliser comme fond de texte la rendrait illisible.
        marque: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
        },
        // Noiratre : texte et surfaces. Le noir pur fatigue sur un
        // ecran de telephone en plein soleil.
        encre: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
