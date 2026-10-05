import type { NextConfig } from 'next';

/**
 * Configuration Next.js.
 *
 * ------------------------------------------------------------------------
 * LE WEB NE PARLE JAMAIS DIRECTEMENT AU NAVIGATEUR
 * ------------------------------------------------------------------------
 * L'API est un serveur distinct, et le navigateur ne doit pas lui
 * parler : cela exposerait le jeton d'accès, contournerait la
 * journalisation des requêtes, et imposerait une configuration CORS
 * ouverte sur chaque surface.
 *
 * Toutes les requêtes passent donc par des gestionnaires de routes
 * Next (`/api/*`), qui appellent l'API côté serveur et transmettent
 * les jetons par cookie `httpOnly`. Le navigateur ne voit jamais de
 * jeton, et le CORS n'a plus lieu d'être.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  experimental: {
    // Les routes API et le rendu serveur ne doivent jamais être mis en
    // cache : une page qui montre une réservation périmée est pire
    // qu'une page lente.
    staleTimes: { dynamic: 0, static: 0 },
  },
};

export default nextConfig;
