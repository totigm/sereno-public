import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'shared',
    include: ['test/**/*.test.ts'],
    // Un paquete sin tests todavía no hace fallar `pnpm test` ni `turbo run test`.
    passWithNoTests: true,
  },
})
