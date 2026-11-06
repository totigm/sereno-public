import { readdirSync } from 'node:fs'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { createDirectDb, type Db } from '../src/client'
import { MIGRATIONS_FOLDER, migrate } from '@sereno/db/migrate'
import { botCommands, sessions, settings } from '../src/schema'

const url = process.env.DATABASE_URL_TEST ?? 'postgresql://postgres@127.0.0.1:5499/sereno_test'

// Las 17 tablas de la spec §10, las 2 de la plata real y las 4 de Better Auth, tal como las devuelve
// `information_schema.tables` (orden alfabético).
const TABLAS = [
  'account',
  'bot_commands',
  'bot_lease',
  'bot_status',
  'candles',
  'decisions',
  'equity_snapshots',
  'futures_data',
  'learning_log',
  'learning_state',
  'market_snapshot',
  'position_events',
  'positions',
  'real_events',
  'real_readiness',
  'session',
  'sessions',
  'settings',
  'settings_history',
  'symbols',
  'universe_days',
  'user',
  'verification',
]

const INDICES: Array<{ tabla: string; columnas: string; unico: boolean }> = [
  { tabla: 'candles', columnas: 'symbol, timeframe, price_type, open_time', unico: true },
  { tabla: 'equity_snapshots', columnas: 'session_id, at DESC', unico: false },
  { tabla: 'decisions', columnas: 'session_id, candle_close_time DESC', unico: false },
  { tabla: 'positions', columnas: 'session_id, closed_at', unico: false },
  { tabla: 'bot_commands', columnas: 'session_id, status, created_at', unico: false },
  { tabla: 'real_events', columnas: 'session_id, at', unico: false },
]

let admin: Pool

beforeAll(async () => {
  // El test vacía la base: sólo acepta una cuyo nombre termine en `_test`.
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error(`DATABASE_URL_TEST debe apuntar a una base *_test, no a ${url}`)
  }
  admin = new Pool({ connectionString: url, max: 1 })
  // `drizzle` es el esquema donde el migrador registra lo aplicado: sin borrarlo,
  // una segunda corrida creería que ya migró y la base quedaría vacía.
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE')
  await admin.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
  await admin.query('CREATE SCHEMA public')
})

afterAll(async () => {
  await admin.end()
})

async function tablasPublicas(): Promise<string[]> {
  const { rows } = await admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  )
  return rows.map((r) => r.table_name)
}

async function definicionesDeIndices(tabla: string): Promise<string[]> {
  const { rows } = await admin.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [tabla],
  )
  return rows.map((r) => r.indexdef)
}

describe('migrate()', () => {
  it('sobre la base limpia crea exactamente las tablas de la spec §10 y Better Auth', async () => {
    expect(await tablasPublicas()).toEqual([])
    await migrate(url)
    expect(await tablasPublicas()).toEqual(TABLAS)
  })

  it('es idempotente: la segunda corrida no falla ni repite migraciones', async () => {
    await expect(migrate(url)).resolves.toBeUndefined()
    const archivos = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql'))
    const { rows } = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations')
    expect(Number(rows[0]?.n)).toBe(archivos.length)
    expect(await tablasPublicas()).toEqual(TABLAS)
  })

  it.each(INDICES)('crea el índice $tabla ($columnas)', async ({ tabla, columnas, unico }) => {
    const defs = await definicionesDeIndices(tabla)
    const match = defs.find((d) => d.endsWith(`(${columnas})`))
    expect(match, `índices de ${tabla}: ${defs.join(' | ')}`).toBeDefined()
    expect(match?.startsWith('CREATE UNIQUE INDEX')).toBe(unico)
  })

  it('market_snapshot tiene fillfactor = 50', async () => {
    const { rows } = await admin.query<{ reloptions: string[] | null }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'market_snapshot' AND relnamespace = 'public'::regnamespace`,
    )
    expect(rows[0]?.reloptions).toContain('fillfactor=50')
  })

  it('el cliente directo escribe y lee con las mismas columnas snake_case que la migración', async () => {
    const direct = createDirectDb(url, { max: 1 })
    const db: Db = direct
    try {
      const startedAt = new Date('2026-10-31T00:00:00Z')
      await db.insert(sessions).values({
        id: 'ses_test',
        kind: 'paper_live',
        name: 'Prueba',
        status: 'active',
        capitalInicial: 1000,
        baseBlindaje: 700,
        settingsSnapshot: DEFAULT_SETTINGS,
        learningOrigin: 'zero',
        startedAt,
      })
      await db.insert(settings).values({ sessionId: 'ses_test', config: DEFAULT_SETTINGS })
      await db.insert(botCommands).values({
        id: '6f1c2a9e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
        sessionId: 'ses_test',
        kind: 'close_all',
        payload: {},
        requestedBy: 'toti@example.com',
      })

      const sesion = await db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.id, 'ses_test') })
      expect(sesion?.capitalInicial).toBe(1000)
      expect(sesion?.settingsSnapshot.risk.riskPerTrade).toBe(DEFAULT_SETTINGS.risk.riskPerTrade)
      expect(sesion?.startedAt.toISOString()).toBe(startedAt.toISOString())

      const config = await db.query.settings.findFirst()
      expect(config?.version).toBe(1)

      const comando = await db.query.botCommands.findFirst()
      expect(comando?.status).toBe('pending')
      expect(comando?.expiresAt).toBeNull()

      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions' ORDER BY ordinal_position`,
      )
      expect(rows.map((r) => r.column_name)).toContain('capital_inicial')
      // El reporte de un replay terminado (spec §9) va en la misma fila de la sesión.
      expect(rows.map((r) => r.column_name)).toContain('report')
    } finally {
      await direct.$client.end()
    }
  })
})
