import { sql, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { DEFAULT_SETTINGS, type SessionKind, type SessionStatus } from '@sereno/shared'
import { createDirectDb, type Db, type DirectDb } from '../../src/client'
import { migrate } from '@sereno/db/migrate'
import { sessions } from '../../src/schema'

export const TEST_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://postgres@127.0.0.1:5499/sereno_test'

// Los tests vacían tablas: sólo aceptan una base cuyo nombre termine en `_test`.
function assertTestUrl(url: string): void {
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error(`DATABASE_URL_TEST debe apuntar a una base *_test, no a ${url}`)
  }
}

// Conexión directa a la base de prueba con las migraciones al día (idempotente).
export async function openTestDb(max = 2): Promise<DirectDb> {
  assertTestUrl(TEST_URL)
  await migrate(TEST_URL)
  return createDirectDb(TEST_URL, { max })
}

// Cada test arranca con las tablas que toca vacías. `CASCADE` arrastra las que
// cuelgan de ellas (truncar `sessions` vacía todo lo de la sesión).
export async function truncate(db: Db, ...tables: PgTable[]): Promise<void> {
  const names: SQL[] = tables.map((t) => sql`${t}`)
  await db.execute(sql`TRUNCATE TABLE ${sql.join(names, sql`, `)} CASCADE`)
}

export const T0 = new Date('2026-10-31T12:00:00Z')

export async function seedSession(
  db: Db,
  id: string,
  { kind = 'paper_live', status = 'archived' }: { kind?: SessionKind; status?: SessionStatus } = {},
): Promise<string> {
  await db.insert(sessions).values({
    id,
    kind,
    name: 'Prueba',
    status,
    capitalInicial: 1000,
    baseBlindaje: 1000,
    settingsSnapshot: DEFAULT_SETTINGS,
    learningOrigin: 'zero',
    startedAt: T0,
  })
  return id
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
