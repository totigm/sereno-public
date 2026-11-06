import { DEFAULT_SETTINGS } from '@sereno/shared'
import { createDirectDb, createRepos, sessions, type DirectDb, type Repos } from '@sereno/db'
import { migrate } from '@sereno/db/migrate'

// Base propia del bot: los tests de `@sereno/db` vacían la suya (DROP SCHEMA, TRUNCATE
// … CASCADE), así que no la comparten por defecto. `DATABASE_URL_TEST` queda de respaldo
// para quien aísla todo con una sola base: el `pnpm test` de la raíz corre los archivos
// de db (sin paralelismo) en un grupo propio, después de los demás proyectos.
export const TEST_URL =
  process.env.DATABASE_URL_TEST_BOT ?? process.env.DATABASE_URL_TEST ?? 'postgresql://postgres@127.0.0.1:5499/sereno_bot_test'

// Varios archivos de test arrancan a la vez contra la misma base y dos migradores en
// paralelo sobre una base vacía chocan: se turnan con un candado de Postgres.
const MIGRATION_LOCK = 1_917_019

export interface TestDb {
  db: DirectDb
  repos: Repos
  // SQL crudo para limpiar sólo las filas de cada archivo (los archivos corren en paralelo).
  query: (text: string, params?: unknown[]) => Promise<void>
  close: () => Promise<void>
}

// Base de prueba con las migraciones al día. Los tests borran filas: sólo aceptan una
// base cuyo nombre termine en `_test`.
export async function openTestDb(): Promise<TestDb> {
  if (!new URL(TEST_URL).pathname.endsWith('_test')) throw new Error(`La base de prueba del bot debe terminar en _test, no ${TEST_URL}`)
  const db = createDirectDb(TEST_URL, { max: 2 })
  const client = await db.$client.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    await migrate(TEST_URL)
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK])
    client.release()
  }
  return {
    db,
    repos: createRepos(db),
    query: async (text, params = []) => {
      await db.$client.query(text, params)
    },
    close: () => db.$client.end(),
  }
}

// Una sesión con id propio del archivo. Archivada: la base admite una sola `active`.
export async function seedSession(t: TestDb, id: string, kind: 'paper_live' | 'replay' = 'paper_live'): Promise<void> {
  await t.query('delete from sessions where id = $1', [id])
  await t.db.insert(sessions).values({
    id,
    kind,
    name: 'Prueba',
    status: kind === 'replay' ? 'listo' : 'archived',
    capitalInicial: 1000,
    baseBlindaje: 1000,
    settingsSnapshot: DEFAULT_SETTINGS,
    learningOrigin: 'zero',
    startedAt: new Date('2026-09-01T00:00:00Z'),
  })
}
