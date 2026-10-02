import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      // CDCS 11.7 : seuil sur les modules metier, pas sur l'ensemble.
      // 70 % global penaliserait les controleurs, qui ne contiennent
      // que de la delegation.
      include: ['src/modules/**/*.ts', 'src/common/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/*.module.ts', '**/main.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
});