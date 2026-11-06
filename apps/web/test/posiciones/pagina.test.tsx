// @vitest-environment node
import type { Candle } from '@sereno/core'
import { candles, type DirectDb } from '@sereno/db'
import { eq } from 'drizzle-orm'
import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import SessionPosicionesPage from '@/app/s/[sessionId]/posiciones/page'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { getLive } from '@/lib/queries/books'
import { getPosicionesData } from '@/lib/queries/posiciones'
import { archiveSeeded, dropSessions, SEEDING_STATUS, seedSession, testSessionId, type TestDb } from '../db'
import { closedPosition, position } from '../fixtures'
import { liveState, withToasts } from './helpers'

// La página de una simulación archivada contra la base de prueba: el filtro de la URL
// llega a la consulta y la pantalla muestra sólo lo que pidió.

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())
vi.mock('@/lib/session', () => ({ requireSession: async () => ({ user: { email: 'owner@example.com' } }) }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn() }))

const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))

const nav = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/s/x/posiciones',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const SESSION = testSessionId('t28_posiciones')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const M15 = 15 * 60_000
// Terminó hace tres días, fuera de la grilla de 15 min (una sesión termina cuando termina); las
// velas siguen hasta hoy (el mercado no se detuvo con la sesión).
const GRID = Math.floor((Date.now() - 3 * DAY) / M15) * M15
const END = GRID + 7 * 60_000
const START = END - 3 * DAY
// Un símbolo sólo de este archivo: la tabla de velas es global.
const SYMBOL = 'T28XUSDT'

function candle(openTime: number): Candle {
  return { openTime, closeTime: openTime + M15 - 1, open: 10, high: 10.2, low: 9.8, close: 10.1, volume: 1, quoteVolume: 10, closed: true }
}

beforeAll(async () => {
  await seedSession(t, SESSION, { status: SEEDING_STATUS, startedAt: START, endedAt: END })
  const { repos } = t
  await repos.positions.close(SESSION, closedPosition('t28-won', { closedAt: END - 5 * HOUR, openedAt: END - 6 * HOUR }), 'Cerré el long en SOL en el take profit: +US$ 9,50 (+1,9R).')
  await repos.positions.close(
    SESSION,
    closedPosition('t28-liq', { symbol: 'DOGEUSDT', openedAt: END - 4 * HOUR, closedAt: END - 3 * HOUR, closeReason: 'liquidation', pnlNet: -50, rMultiple: -10 }),
    'Me liquidaron el long en DOGE: perdí los US$ 50 de margen.',
  )
  await repos.positions.close(
    SESSION,
    closedPosition('t28-late', { symbol: SYMBOL, entryPrice: 10, exitPrice: 10.1, openedAt: END - 4 * HOUR, closedAt: END - 2.5 * HOUR }),
    'Cerré el long en T28X en el take profit: +US$ 9,50 (+1,9R).',
  )
  await repos.positions.upsertOpen(SESSION, position('t28-open', { symbol: SYMBOL, entryPrice: 10, openedAt: END - 2 * HOUR }))
  const series: Candle[] = []
  for (let at = GRID - 8 * HOUR; at < Date.now(); at += M15) series.push(candle(at))
  await repos.candles.upsertMany({ symbol: SYMBOL, timeframe: '15m', priceType: 'last' }, series)
  await archiveSeeded(t, SESSION, END)
  live.current = liveState((await getLive(SESSION))!)
})

afterAll(async () => {
  await t.db.delete(candles).where(eq(candles.symbol, SYMBOL))
  await dropSessions(t, [SESSION])
  await t.db.$client.end()
})

async function renderPage(searchParams: Record<string, string>): Promise<string> {
  nav.search = new URLSearchParams(searchParams).toString()
  const page = await SessionPosicionesPage({ params: Promise.resolve({ sessionId: SESSION }), searchParams: Promise.resolve(searchParams) })
  return renderToString(withToasts(page))
}

describe('Posiciones de una sesión archivada', () => {
  it('el filtro "liquidadas" deja sólo las liquidaciones', async () => {
    const html = await renderPage({ vista: 'cerradas', liquidadas: '1' })
    expect(html).toContain('trade=t28-liq')
    expect(html).not.toContain('trade=t28-won')
    expect(html).toContain('Liquidada')
  })

  it('sin filtros están las dos, y la abierta que quedó va en pasado y sin "Cerrar ahora"', async () => {
    const closed = await renderPage({ vista: 'cerradas' })
    expect(closed).toContain('trade=t28-liq')
    expect(closed).toContain('trade=t28-won')
    const open = await renderPage({ vista: 'abiertas' })
    expect(open).toContain('Terminó con 1 abierta')
    expect(open).not.toContain('Cerrar ahora')
  })

  it('un id que no es de la sesión da 404', async () => {
    await expect(
      SessionPosicionesPage({ params: Promise.resolve({ sessionId: 'ses_que_no_existe' }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('la abierta de una sesión terminada se dibuja hasta el final de la sesión: ni una vela de después', async () => {
    const trade = (await getPosicionesData(SESSION, { trade: 't28-open' }))?.trade
    // La última es la que cerró antes del final. La que estaba en curso (GRID…GRID+15 min) cerró
    // después: su máximo, su mínimo y su cierre traen mercado que la sesión no vivió.
    expect(trade?.candles.at(-1)?.openTime).toBe(GRID - M15)
    expect(trade?.candles.every((c) => c.closeTime <= END)).toBe(true)
    // La primera que abre desde 4 h antes de la entrada (END − 6 h, fuera de la grilla).
    expect(trade?.candles[0]?.openTime).toBe(GRID - 6 * HOUR + M15)
  })

  it('una cerrada cerca del final lleva aire después de la salida, pero tampoco pasa del final', async () => {
    const trade = (await getPosicionesData(SESSION, { trade: 't28-late' }))?.trade
    expect(trade?.closed).toBe(true)
    expect(trade?.candles[0]?.openTime).toBe(GRID - 8 * HOUR + M15)
    expect(trade?.candles.at(-1)?.openTime).toBe(GRID - M15)
  })
})
