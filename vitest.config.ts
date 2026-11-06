import { defineConfig } from 'vitest/config'

// Un solo `pnpm test` en la raíz corre los tests de todos los paquetes y apps.
// Cada paquete declara su proyecto en su propio `vitest.config.ts` (nombre, entorno,
// includes); eso también permite `pnpm --filter @sereno/<pkg> test` por separado.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
})
