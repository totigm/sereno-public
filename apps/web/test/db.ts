import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { createDirectDb, createRepos, sessions, type DirectDb, type Repos } from '@sereno/db'
import { migrate } from '@sereno/db/migrate'
import { DEFAULT_SETTINGS, type BinanceEnv, type RealStatus, type SessionStatus } from '@sereno/shared'

// Base de prueba para los tests de la capa de datos. Los archivos corren en
// paralelo: cada uno usa ids de sesión propios y borra sólo lo suyo, nunca vacía tablas.
export const TEST_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://postgres@127.0.0.1:5499/sereno_test'

// Clave del candado que serializa las migraciones de archivos que arrancan a la vez.
const MIGRATION_LOCK = 25_250_025
// Clave del candado que turna a los archivos que crean sesiones activas (ver `holdActiveSessions`).
const ACTIVE_SESSIONS_LOCK = 25_250_026

function assertTestUrl(url: string): void {
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error(`DATABASE_URL_TEST debe apuntar a una base *_test, no a ${url}`)
  }
}

export interface TestDb {
  db: DirectDb
  repos: Repos
}

/** Lo que reemplaza a `@/lib/db` en los tests: la base de prueba con las migraciones al día. */
export async function openTestDb(): Promise<TestDb> {
  assertTestUrl(TEST_URL)
  const db = createDirectDb(TEST_URL, { max: 4 })
  const lock = await db.$client.connect()
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    await migrate(TEST_URL)
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK])
    lock.release()
  }
  return { db, repos: createRepos(db) }
}

export const T0 = Date.parse('2026-10-14T13:00:00Z')

export function testSessionId(label: string): string {
  return `ses_t25_${label}_${randomUUID()}`
}

/** Una sesión con sus ajustes (versión 1), sin pasar por `createLive` (que exige que no haya otra activa del tipo). */
export async function seedSession(
  t: TestDb,
  id: string,
  {
    status = 'archived',
    startedAt = T0,
    endedAt = startedAt + 86_400_000,
    capitalInicial = 1000,
    kind = 'paper_live',
  }: { status?: SessionStatus; startedAt?: number; endedAt?: number; capitalInicial?: number; kind?: 'paper_live' | 'live' } = {},
): Promise<string> {
  await t.db.insert(sessions).values({
    id,
    kind,
    name: kind === 'live' ? 'Plata real' : 'Simulación',
    ...(kind === 'live' ? { binanceEnv: 'testnet' as const, realStatus: 'on' as const } : {}),
    status,
    capitalInicial,
    baseBlindaje: capitalInicial,
    protegido: 0,
    settingsSnapshot: DEFAULT_SETTINGS,
    learningOrigin: 'zero',
    startedAt: new Date(startedAt),
    ...(status === 'archived' ? { endedAt: new Date(endedAt) } : {}),
  })
  await t.repos.settings.create(id, DEFAULT_SETTINGS, { by: 'owner@example.com' })
  return id
}

/**
 * Estado para sembrar la historia de una sesión que después se archiva: los repos
 * rechazan escribir posiciones en una archivada (como el bot tras "Nueva simulación"),
 * así que se siembra con un estado que no es `active` (no choca con el índice de una
 * sola activa) ni `archived`, se escriben las posiciones y recién después se archiva.
 */
export const SEEDING_STATUS: SessionStatus = 'listo'

/** Archiva una sesión sembrada con `SEEDING_STATUS` una vez escrita su historia. */
export async function archiveSeeded(t: TestDb, id: string, endedAt = T0 + 86_400_000): Promise<void> {
  await t.db.update(sessions).set({ status: 'archived', endedAt: new Date(endedAt) }).where(eq(sessions.id, id))
}

export async function dropSessions(t: TestDb, ids: readonly string[]): Promise<void> {
  for (const id of ids) await t.db.delete(sessions).where(eq(sessions.id, id))
}

/** La activa de otra corrida cortada dejaría fallar `createLive`: se archiva antes de empezar. */
export async function archiveStrayActive(t: TestDb): Promise<void> {
  await t.db.execute(sql`update sessions set status = 'archived', ended_at = now() where status = 'active'`)
}

/** Una sesión con plata real activa (sin pasar por `createReal`, que no deja elegir el estado). */
export async function seedRealSession(
  t: TestDb,
  id: string,
  { realStatus = 'on', binanceEnv = 'testnet', capitalInicial = 50 }: { realStatus?: RealStatus; binanceEnv?: BinanceEnv; capitalInicial?: number } = {},
): Promise<string> {
  const settings = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.5 } }
  await t.db.insert(sessions).values({
    id,
    kind: 'live',
    name: 'Plata real',
    status: 'active',
    capitalInicial,
    baseBlindaje: capitalInicial,
    protegido: 0,
    settingsSnapshot: settings,
    learningOrigin: 'zero',
    startedAt: new Date(Date.now() - 3_600_000),
    binanceEnv,
    realStatus,
    realChangedAt: new Date(Date.now() - 3_600_000),
  })
  await t.repos.settings.create(id, settings, { by: 'owner@example.com' })
  return id
}

/**
 * La base admite una sola activa por tipo, y `archiveStrayActive` archiva las de todos:
 * los archivos que crean sesiones activas corren en paralelo, así que se turnan con un
 * candado que toman al empezar y sueltan al terminar. Devuelve con qué soltarlo.
 */
export async function holdActiveSessions(t: TestDb): Promise<() => Promise<void>> {
  const client = await t.db.$client.connect()
  await client.query('select pg_advisory_lock($1)', [ACTIVE_SESSIONS_LOCK])
  return async () => {
    await client.query('select pg_advisory_unlock($1)', [ACTIVE_SESSIONS_LOCK])
    client.release()
  }
}
