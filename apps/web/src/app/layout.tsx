import type { Metadata } from 'next';
import Link from 'next/link';

import { currentUser } from '@/lib/api';
import { Deconnexion } from './deconnexion';
import './globals.css';

export const metadata: Metadata = {
  title: 'AdkCars CI — location de véhicules en Côte d’Ivoire',
  description:
    'Louez une berline, un SUV ou un utilitaire à Abidjan. Vérifiés, ' +
    'avec caution explicite et assurance incluse.',
};

/**
 * Coquille de l'application.
 *
 * Rendue cote serveur : la session est lue une seule fois ici et passee
 * en props plutot que relue par chaque page.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const estAdmin = user?.roles.includes('admin') ?? false;

  return (
    <html lang="fr">
      <body className="min-h-screen">
        <header className="border-b border-encre-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-bold text-encre-900">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-marque-600 text-sm text-white">
                A
              </span>
              <span>AdkCars CI</span>
            </Link>

            <nav className="flex items-center gap-1 text-sm">
              <Link href="/" className="rounded-lg px-3 py-2 font-medium text-encre-600 hover:bg-encre-100">
                Véhicules
              </Link>

              {user && (
                <Link
                  href="/reservations"
                  className="rounded-lg px-3 py-2 font-medium text-encre-600 hover:bg-encre-100"
                >
                  Mes réservations
                </Link>
              )}

              {estAdmin && (
                <Link
                  href="/admin/vehicules"
                  className="rounded-lg px-3 py-2 font-medium text-encre-600 hover:bg-encre-100"
                >
                  Validation
                </Link>
              )}

              {user ? (
                <Deconnexion />
              ) : (
                <Link href="/connexion" className="bouton-primaire ml-1">
                  Se connecter
                </Link>
              )}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>

        <footer className="mt-12 border-t border-encre-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-encre-500">
            <p>
              AdkCars CI — location de véhicules à Abidjan. Les montants sont
              affichés en francs CFA (XOF), sans subunit.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
