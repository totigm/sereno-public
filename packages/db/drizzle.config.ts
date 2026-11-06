import { defineConfig } from 'drizzle-kit'

// Sólo `generate`: las migraciones se aplican con `scripts/migrate.ts` sobre la
// URL directa. Sin `dbCredentials` a propósito, así `drizzle-kit push` no tiene
// contra qué correr (la spec §10 lo prohíbe contra Neon).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
})
