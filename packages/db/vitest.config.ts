import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'db',
    include: ['test/**/*.test.ts'],
    // Un paquete sin tests todavía no hace fallar `pnpm test` ni `turbo run test`.
    passWithNoTests: true,
    // Todos los archivos comparten la base de prueba y `migrate.test.ts` la vacía:
    // de a uno, para que ningún test vea la base a medio crear.
    fileParallelism: false,
  },
})
