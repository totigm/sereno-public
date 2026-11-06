import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    // Un paquete sin tests todavía no hace fallar `pnpm test` ni `turbo run test`.
    passWithNoTests: true,
    setupFiles: ['test/setup.ts'],
    css: false,
  },
})
