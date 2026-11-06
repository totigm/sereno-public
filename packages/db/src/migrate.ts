import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator'
import { createDirectDb } from './client'

// Con `new URL('../migrations', import.meta.url)` Turbopack intenta empaquetar la carpeta
// como un asset y el dashboard no compila al importar `@sereno/db`; con `path` la ruta se
// arma recién al ejecutar.
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// Aplica las migraciones pendientes de `migrations/` con una conexión directa
// propia: nunca por el pooler. Idempotente: el migrador registra lo aplicado en
// `drizzle.__drizzle_migrations` y saltea lo que ya corrió.
export async function migrate(url: string): Promise<void> {
  const db = createDirectDb(url, { max: 1 })
  try {
    await applyMigrations(db, { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await db.$client.end()
  }
}
