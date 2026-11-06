import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'bot',
    include: ['test/**/*.test.{ts,tsx}'],
    // Un paquete sin tests todavía no hace fallar `pnpm test` ni `turbo run test`.
    passWithNoTests: true,
    // Los tests del runtime en vivo escriben velas, futuros y contratos del universo del
    // Binance falso (los mismos que limpian y cuentan los de los jobs) y la base admite
    // una sola sesión activa: de a un archivo, ninguno ve filas de otro.
    fileParallelism: false,
  },
})
