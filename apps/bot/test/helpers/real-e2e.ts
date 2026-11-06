import type { PositionRecord, SessionRow } from '@sereno/db'
import type { BinanceEnv } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { priceAt } from '../../src/binance/fake/fixtures'
import type { RecordedRequest } from '../../src/binance/fake/server'
import { runRealOffCli } from '../../src/real/real-off'
import { createActiveSession, fixedScorer, M15 } from './live'
import { closeRealWorld, createRealOnly, createSessions, openRealWorld, resetRealWorld, startRealLive, type E2eSessions, type RealLive, type RealLiveOptions, type RealWorld } from './real-live'

// Los pasos y las miradas de los tests de punta a punta de la plata real (`test/real/e2e*`).

// 12:15 UTC: un borde de 15m que no cierra velas de 1h ni de 4h; el bot arranca 20 s antes.
export const T = Date.UTC(2026, 10, 2, 12, 15, 0)
export const START = T - 20_000
export const HOUR = 3_600_000
export const WAIT = { timeout: 8_000, interval: 25 }
export const ETH = 'ETHUSDT'
export const BTC = 'BTCUSDT'
export const round2 = (x: number) => Math.round(x * 100) / 100
// Las marcas de la cuenta son las mismas que las del REST del falso: al reiniciar, el precio
// que el bot lee por REST no cruza nada que Binance no haya cruzado.
export const ENTRY = round2(priceAt(ETH, T))
export const BTC_ENTRY = Math.round(priceAt(BTC, T) * 10) / 10
export const ONLY_ETH = fixedScorer({ [ETH]: 0.8 })
export const BOTH = fixedScorer({ [ETH]: 0.8, [BTC]: 0.8 })

export const SIGNED_ORDER = '/fapi/v1/order'
export const ALGO = '/fapi/v1/algoOrder'
// Lo que lee la revisión de la cuenta (`real/checks.ts`).
export const READINESS_PATHS = new Set(['/sapi/v1/account/apiRestrictions', '/fapi/v1/positionSide/dual', '/fapi/v3/balance', '/fapi/v1/multiAssetsMargin', '/fapi/v1/feeBurn'])

export interface E2e {
  readonly world: RealWorld
  // Las dos sesiones (papel y real), que se borran al terminar el test.
  sessionsFor(realEnv: BinanceEnv, lossCap?: number): Promise<E2eSessions>
  // La de papel sola, que también se borra.
  paperSession(): Promise<SessionRow>
  // Otra real activa (archiva la anterior), que también se borra.
  nextReal(options: { realEnv: BinanceEnv; capital: number }): Promise<SessionRow>
  // El proceso con ETH sola, en testnet, con la variable y las claves, ya listo y con los streams abiertos.
  begin(options?: Partial<RealLiveOptions>): Promise<RealLive>
  restart(l: RealLive, patch?: Parameters<RealLive['restart']>[0]): Promise<RealLive>
}

// Abre los dos falsos y la base una vez por archivo; cada test empieza con los falsos limpios y
// termina con el proceso parado y sus sesiones borradas.
export function useRealE2e(): E2e {
  let world: RealWorld | null = null
  let live: RealLive | null = null
  const created: string[] = []
  const w = (): RealWorld => {
    if (!world) throw new Error('el mundo de punta a punta todavía no abrió')
    return world
  }
  const ready = async (next: RealLive): Promise<RealLive> => {
    live = next
    await next.runtime.ready()
    next.openStreams()
    return next
  }

  beforeAll(async () => {
    world = await openRealWorld()
  })
  afterAll(async () => {
    if (world) await closeRealWorld(world)
  })
  beforeEach(() => {
    resetRealWorld(w())
  })
  afterEach(async () => {
    await live?.runtime.stop()
    live = null
    await w().t.query('delete from sessions where id = any($1)', [created.splice(0)])
  })

  return {
    get world() {
      return w()
    },
    sessionsFor: async (realEnv, lossCap) => {
      const s = await createSessions(w().t, { realEnv, ...(lossCap !== undefined ? { lossCap } : {}) })
      created.push(s.paper.id, s.real.id)
      return s
    },
    paperSession: async () => {
      const paper = await createActiveSession(w().t)
      created.push(paper.id)
      return paper
    },
    nextReal: async (options) => {
      const real = await createRealOnly(w().t, options)
      created.push(real.id)
      return real
    },
    begin: async (options = {}) => ready(await startRealLive(w(), { env: 'testnet', enabled: true, keys: true, scorer: ONLY_ETH, start: START, ...options })),
    restart: async (l, patch = {}) => ready(await l.restart(patch)),
  }
}

// El ciclo de las `at`: las velas de las dos monedas a todos los streams.
export async function cycle(l: RealLive, at: number): Promise<void> {
  await l.clock.advanceTo(at)
  l.pushKline(BTC, at - M15)
  l.pushKline(ETH, at - M15)
}

// El ciclo de las 12:15 con las marcas dadas: lo que la real abre, ya protegido.
export async function openAt(l: RealLive, sessionId: string, marks: Record<string, number> = { [ETH]: ENTRY }): Promise<PositionRecord[]> {
  for (const [symbol, price] of Object.entries(marks)) l.pushMark(symbol, price)
  await cycle(l, T)
  let open: PositionRecord[] = []
  await vi.waitFor(async () => {
    open = await l.t.repos.positions.listOpen(sessionId)
    expect(open.map((p) => p.symbol).sort()).toEqual(Object.keys(marks).sort())
    for (const p of open) expect(p.tpOrderId).toEqual(expect.any(String))
  }, WAIT)
  return open
}

// Que la del ciclo `at` decidió por las dos monedas.
export async function decided(l: RealLive, sessionId: string, at: number): Promise<void> {
  await vi.waitFor(async () => expect(await l.t.repos.decisions.range(sessionId, at, at + 1)).toHaveLength(2), WAIT)
}

type ClosedItem = Awaited<ReturnType<RealLive['t']['repos']['positions']['listClosed']>>['items'][number]

export async function closedOf(l: RealLive, sessionId: string, count = 1): Promise<ClosedItem[]> {
  let items: ClosedItem[] = []
  await vi.waitFor(async () => {
    items = (await l.t.repos.positions.listClosed(sessionId)).items
    expect(items).toHaveLength(count)
  }, WAIT)
  return items
}

export async function closeEvent(l: RealLive, positionId: string) {
  const event = (await l.t.repos.positions.listEvents(positionId)).find((e) => e.kind === 'close')
  return event?.payload as { price: number; qty: number; fee: number; reported?: true } | undefined
}

export async function journaled(l: RealLive, sessionId: string, kind: string, phrase?: string): Promise<boolean> {
  const events = await l.t.repos.realEvents.list(sessionId, { from: 0, to: T + 30 * 24 * HOUR })
  return events.some((e) => e.kind === kind && (phrase === undefined || e.phrase.includes(phrase)))
}

export const isOrder = (kind: 'o' | 'c' | 'x') => (r: RecordedRequest) =>
  r.method === 'POST' && r.path === SIGNED_ORDER && new RegExp(`^sereno-[0-9a-f]{8}-${kind}`).test(r.query.newClientOrderId ?? '')
export const algoPosts = (l: RealLive) => l.fakeReal.requests.filter((r) => r.method === 'POST' && r.path === ALGO)
export const newAlgos = (l: RealLive, symbol = ETH) => l.fakeReal.trading.algos.filter((a) => a.symbol === symbol && a.algoStatus === 'NEW')
export const tradesOf = (l: RealLive, symbol = ETH) => l.fakeReal.trading.trades.filter((t) => t.symbol === symbol)
// 1R de la abierta, en precio.
export const oneR = (p: PositionRecord) => p.entryPrice - p.stopPrice

// Que el algo `placed` se pidió antes de cancelar `cancelled`.
export function placedBeforeCancelled(l: RealLive, placed: string, cancelled: string): void {
  const requests = l.fakeReal.requests
  const post = requests.findIndex((r) => r.method === 'POST' && r.path === ALGO && r.query.clientAlgoId === placed)
  const del = requests.findIndex((r) => r.method === 'DELETE' && r.path === ALGO && r.query.clientAlgoId === cancelled)
  expect(post).toBeGreaterThan(-1)
  expect(del).toBeGreaterThan(post)
}

const TESTNET_FAPI = 'https://demo-fapi.binance.com'

// `pnpm bot real-off` contra el falso de testnet, con el reloj del test. Un pedido a otro host
// tira: nunca sale a Binance de verdad.
export function realOffCli(l: RealLive, out: string[]): Promise<number> {
  const toFake: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(`${TESTNET_FAPI}/`)) throw new Error(`real-off pidió ${url}: el test sólo habla con el falso de testnet`)
    return fetch(l.fakeTest.baseUrl + url.slice(TESTNET_FAPI.length), init)
  }
  const env = { DATABASE_URL_UNPOOLED: 'postgresql://no-se-usa:5432/la-base-viene-en-deps', LOG_LEVEL: 'silent', BINANCE_ENV: 'testnet', BINANCE_TRADE_API_KEY: FAKE_API_KEY, BINANCE_TRADE_API_SECRET: FAKE_API_SECRET }
  return runRealOffCli([], { env, fetch: toFake, db: l.t.db, stdout: (line) => out.push(line), stderr: (line) => out.push(line), now: l.clock.now })
}

// Dos ciclos de la de papel con ETH a la marca del falso: sus decisiones y su abierta, sin ids.
export async function paperRun(l: RealLive, paperId: string) {
  l.pushMark(ETH, ENTRY)
  await cycle(l, T)
  await decided(l, paperId, T)
  await cycle(l, T + M15)
  await decided(l, paperId, T + M15)
  const rows = await l.t.repos.decisions.range(paperId, T, T + M15 + 1)
  const open = await l.t.repos.positions.listOpen(paperId)
  return {
    decisions: rows.map(({ id: _id, sessionId: _s, ...rest }) => rest),
    open: open.map(({ id: _id, sessionId: _s, ...rest }) => rest),
  }
}
