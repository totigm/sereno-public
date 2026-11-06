// @vitest-environment node
import type { SignalResult } from '@sereno/core'
import { initialLearningState } from '@sereno/core/src/learning/state'
import { decisions, symbols, type DirectDb, type SymbolUpsert } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { getAjustesData } from '@/lib/queries/ajustes'
import { getAprendizajeData } from '@/lib/queries/aprendizaje'
import { getMonedasData } from '@/lib/queries/monedas'
import { getPosicionesData, parsePosicionesQuery } from '@/lib/queries/posiciones'
import { getResumenData } from '@/lib/queries/resumen'
import { getContext } from '@/lib/queries/session'
import { equityNativeMs } from '@/lib/queries/equity-gap'
import { equitySeries } from '@/lib/queries/sql/equity'
import { archiveSeeded, dropSessions, SEEDING_STATUS, seedSession, testSessionId, type TestDb } from '../db'
import { closedPosition, position } from '../fixtures'

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())

const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const SESSION = testSessionId('queries')
// Una simulación sin puntos en I₀: la comparación con la sombra tiene que arrancar en I₀ igual.
const SHADOW_SESSION = testSessionId('queries_shadow')
// Curvas con la resolución de cada tipo: replay de a 15 min y vivo de a 1 min.
const GAP_REPLAY = testSessionId('queries_gap_replay')
const GAP_LIVE = testSessionId('queries_gap_live')
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Una simulación archivada que termina en 10 minutos: así lo que la base sella con
// `now()` (historia de ajustes) cae dentro de su período.
const END = Date.now() + 10 * 60_000
const START = END - 3 * DAY
const PENALTY_UNTIL = END + 3 * DAY
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10)
// El catálogo de contratos es global: este archivo sólo agrega y borra ETHUSDT.
const ETH_CONTRACT: SymbolUpsert = {
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  contractType: 'PERPETUAL',
  status: 'TRADING',
  minNotional: 20,
  minQty: 0.001,
  stepSize: 0.001,
  tickSize: 0.01,
  quantityPrecision: 3,
  underlyingType: 'COIN',
  underlyingSubType: ['Layer-1'],
  onboardDate: Date.UTC(2019, 10, 27),
  fundingIntervalHours: 8,
  liquidationFee: 0.0125,
  mmr: 0.005,
}

const signals = (trend: number, momentum: number | null): SignalResult[] => [
  { id: 'trend15m', value: trend },
  { id: 'momentum', value: momentum },
]

beforeAll(async () => {
  await seedSession(t, SESSION, { status: SEEDING_STATUS, startedAt: START, endedAt: END })
  const { repos, db } = t

  await repos.positions.upsertOpen(SESSION, position('q-open', { openedAt: END - 3.5 * HOUR }))
  await repos.positions.close(
    SESSION,
    closedPosition('q-won1', { openedAt: END - 3.5 * HOUR, closedAt: END - 2.5 * HOUR, pnlNet: 9.5, signalsAtOpen: signals(0.6, -0.2) }),
    'Cerré el long en SOL en el take profit: +US$ 9,50 (+1,9R).',
  )
  await repos.positions.close(
    SESSION,
    closedPosition('q-won2', {
      symbol: 'ETHUSDT',
      side: 'short',
      openedAt: END - 7 * HOUR,
      closedAt: END - 6 * HOUR,
      pnlNet: 4,
      signalsAtOpen: signals(-0.5, 0.3),
    }),
    'Cerré el short en ETH en el take profit: +US$ 4,00 (+0,8R).',
  )
  await repos.positions.close(
    SESSION,
    closedPosition('q-liq', {
      symbol: 'DOGEUSDT',
      openedAt: END - 2 * HOUR,
      closedAt: END - 1 * HOUR,
      closeReason: 'liquidation',
      pnlNet: -50,
      rMultiple: -10,
      signalsAtOpen: signals(0.4, null),
    }),
    'Me liquidaron el long en DOGE: perdí los US$ 50 de margen.',
  )
  await repos.positions.close(SESSION, closedPosition('q-shadow', { shadow: true, closedAt: END - 2 * HOUR, pnlNet: 3 }), 'sombra')

  await repos.positions.addEvent('q-open', { kind: 'stop_moved', payload: { from: 122.5, to: 125 }, at: END - 3 * HOUR })
  await repos.positions.addEvent('q-open', { kind: 'funding', payload: { amount: 0.08 }, at: END - 2.9 * HOUR })
  // Menos del 0,1% del margen: no es relevante para el diario.
  await repos.positions.addEvent('q-open', { kind: 'funding', payload: { amount: 0.01 }, at: END - 2.8 * HOUR })

  const point = (at: number, equity: number, shadowEquity: number, kind: 'minute' | 'event' = 'event') => ({
    at,
    saldo: equity,
    equity,
    margenEnUso: 50,
    protegido: 0,
    capitalBase: equity,
    capitalOperable: equity - 50,
    shadowEquity,
    kind,
  })
  await repos.equity.insert(SESSION, [
    point(END - 5 * HOUR, 1000, 1000),
    point(END - 4 * HOUR, 1100, 1020),
    point(END - 3 * HOUR, 990, 1010, 'minute'),
    point(END - 2 * HOUR, 1050, 1040),
  ])

  await repos.market.upsert(SESSION, [
    { symbol: 'SOLUSDT', markPrice: 127.5, change24h: 0.02, sPrime: 0.4, lean: 0.4, state: 'in_position' },
    { symbol: 'ETHUSDT', markPrice: 2600, change24h: -0.01, sPrime: -0.1, lean: -0.1, state: 'ready' },
    { symbol: 'DOGEUSDT', markPrice: 0.12, change24h: 0, sPrime: null, lean: 0, state: 'penalized', stateUntil: new Date(PENALTY_UNTIL).toISOString() },
  ])

  // Doce decisiones con retorno a 4 h que crece con la tendencia: fiabilidad 1.
  const decision = (at: number, symbol: string, sPrime: number, action: string, extra: Record<string, unknown> = {}) => ({
    sessionId: SESSION,
    symbol,
    candleCloseTime: new Date(at),
    s: sPrime,
    sPrime,
    signals: signals(0.5, 0.5),
    missingSignals: [],
    action: action as 'wait',
    ...extra,
  })
  await db.insert(decisions).values([
    ...Array.from({ length: 12 }, (_, i) =>
      decision(END - 30 * HOUR + i * 15 * 60_000, 'SOLUSDT', 0.1, 'wait', { signals: signals((i + 1) / 10, 0.5), forwardReturn4h: (i + 1) / 1000 }),
    ),
    decision(END - 20 * 60_000, 'ETHUSDT', 0.05, 'blocked:below_min_notional', { blockedBy: 'below_min_notional' }),
    decision(END - 15 * 60_000, 'SOLUSDT', 0.4, 'blocked:low_volume', { blockedBy: 'low_volume' }),
  ])

  await repos.learning.save(SESSION, {
    ...initialLearningState(START),
    // El escenario (un 0,4 bloqueado por volumen "espera") se escribió con θ 0,35.
    params: { ...initialLearningState(START).params, theta: 0.35, k: 1.5 },
    confidenceBySymbol: { SOLUSDT: 0.3, DOGEUSDT: -0.45 },
    tradesBySymbol: { SOLUSDT: 1, DOGEUSDT: 9 },
    weightsBySymbol: { SOLUSDT: { trend15m: 2 } },
    penalties: { DOGEUSDT: PENALTY_UNTIL },
    closedTrades: 3,
  })
  const log = (at: number, kind: string, message: string) => ({ at, kind, symbol: null, signal: null, message, sampleSize: 60, before: null, after: null })
  await repos.learning.appendLog(SESSION, [
    log(END - 2 * DAY, 'params', 'Adopté θ 0,40.'),
    log(END - DAY, 'params_rejected', 'Rechacé θ 0,45.'),
    log(END - 0.5 * DAY, 'params_rejected', 'Rechacé k 2,0.'),
    { ...log(END - 2 * HOUR, 'weight_trade', 'Trade 3 en SOLUSDT (long, +1,90R): subí trend15m (n = 3).'), symbol: 'SOLUSDT' },
  ])

  const paused = { ...DEFAULT_SETTINGS.pause, paused: true, by: 'user' as const, at: new Date().toISOString() }
  await repos.settings.update(SESSION, { pause: paused }, 1, { by: 'owner@example.com' })
  // K = 1 en lugar de 30: con un trade en SOL, λ = 1/2 y el peso de la tendencia queda en (1 + 2) / 2.
  const learning = { ...DEFAULT_SETTINGS.learning, shrinkageK: 1 }
  await repos.settings.update(SESSION, { pause: DEFAULT_SETTINGS.pause, learning }, 2, { by: 'owner@example.com' })
  // El último universo del día es el que vale; el anterior ya no se muestra.
  await repos.universeDays.upsertDay(SESSION, { day: utcDay(END - 2 * DAY), symbols: [], excluded: { OLDUSDT: { reason: 'status', detail: 'SETTLING' } } })
  await repos.universeDays.upsertDay(SESSION, {
    day: utcDay(END),
    symbols: [],
    excluded: { NEWUSDT: { reason: 'history', detail: '2026-10-15', pinned: true }, XAUUSDT: { reason: 'tradfi' } },
  })
  await repos.symbols.upsertMany([ETH_CONTRACT])

  await archiveSeeded(t, SESSION, END)
})

afterAll(async () => {
  await t.db.delete(symbols).where(eq(symbols.symbol, ETH_CONTRACT.symbol))
  await dropSessions(t, [SESSION, SHADOW_SESSION, GAP_REPLAY, GAP_LIVE])
  await t.db.$client.end()
})

describe('getContext', () => {
  it('una simulación archivada es de sólo lectura y no está activa', async () => {
    const ctx = await getContext(SESSION)
    expect(ctx).toMatchObject({ isActive: false, isReplay: false, isArchived: true })
    expect(ctx.session?.period).toEqual({ from: START, to: END })
  })

  it('un id que no existe da sesión null', async () => {
    expect((await getContext('ses_que_no_existe')).session).toBeNull()
  })
})

describe('getResumenData', () => {
  it('veredicto, estadísticas y drawdown de la cartera real', async () => {
    const data = await getResumenData(SESSION)
    expect(data?.verdict.status).toBe('insufficient')
    expect(data?.verdict.reason).toBe('Con 3 operaciones en 3 días todavía no se puede saber si tiene ventaja; faltan 97 operaciones y 27 días.')
    expect(data?.stats).toMatchObject({ trades: 3, wins: 2, losses: 1, liquidations: 1 })
    expect(data?.stats.profitFactor).toBeCloseTo(13.5 / 50, 9)
    expect(data?.stats.maxDrawdown.pct).toBeCloseTo(0.1, 9)
    expect(data?.stats.maxDrawdown).toMatchObject({ peakAt: END - 4 * HOUR, troughAt: END - 3 * HOUR, resolution: 'minute' })
    expect(data?.equity.defaultRange).toBe('todo')
    expect(data?.shieldedAt).toBeNull()
  })

  it('la curva marca los huecos de más de 5 minutos', async () => {
    const points = (await getResumenData(SESSION))?.equity.ranges.todo.points ?? []
    expect(points.map((p) => [p.equity, p.gapBefore])).toEqual([
      [1000, false],
      [1100, true],
      [990, true],
      [1050, true],
    ])
  })

  it('el libro sale de las posiciones: saldo, cerradas y ganadas', async () => {
    const live = (await getResumenData(SESSION))?.live
    expect(live?.ledger).toMatchObject({ saldo: 1000 + 9.5 + 4 - 50 - 0.125, closedCount: 3, wonCount: 2 })
    expect(live?.open.map((p) => p.id)).toEqual(['q-open'])
  })

  it('el diario junta aperturas, cierres, stops, funding relevante, pausas, aprendizaje y esperas', async () => {
    const journal = (await getResumenData(SESSION))?.journal
    const texts = journal?.entries.map((e) => [e.kind, e.text]) ?? []
    expect(texts).toContainEqual(['stop_moved', 'Moví el stop del long en SOL a la entrada (125,00).'])
    expect(texts).toContainEqual(['funding', 'Pagué US$ 0,08 de funding por el long en SOL.'])
    expect(texts.filter(([kind]) => kind === 'funding')).toHaveLength(1)
    expect(texts).toContainEqual(['waited', 'Miré SOL y esperé: la inclinación es fuerte pero el volumen no acompaña.'])
    expect(texts).toContainEqual(['pause', 'Me pausaste: no abro nada nuevo y sigo cuidando las abiertas.'])
    expect(texts).toContainEqual(['resume', 'Me reanudaste: vuelvo a buscar entradas.'])
    expect(texts).toContainEqual(['learning', 'Trade 3 en SOL (long, +1,90R): subí el peso de la tendencia de 15 minutos (n = 3).'])
    expect(journal?.entries.find((e) => e.kind === 'liquidation')).toMatchObject({ highlight: true, pnl: -50, symbol: 'DOGEUSDT' })
    expect(journal?.entries.filter((e) => e.kind === 'open').map((e) => e.positionId).sort()).toEqual(['q-liq', 'q-open', 'q-won1', 'q-won2'])
    expect(journal?.summary).toMatchObject({ trades: 3, won: 2, liquidations: 1 })
    expect(journal?.summary.pnl).toBeCloseTo(-36.5, 9)
    // Lo más nuevo primero.
    const times = journal?.entries.map((e) => e.at) ?? []
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })
})

describe('equitySeries: huecos según la resolución de la sesión', () => {
  const MIN = 60_000
  const GAP_START = START
  const curvePoint = (at: number, equity: number) => ({
    at,
    saldo: equity,
    equity,
    margenEnUso: 0,
    protegido: 0,
    capitalBase: equity,
    capitalOperable: equity,
    shadowEquity: equity,
    kind: 'event' as const,
  })

  beforeAll(async () => {
    await seedSession(t, GAP_REPLAY, { status: SEEDING_STATUS, startedAt: GAP_START, endedAt: END })
    await seedSession(t, GAP_LIVE, { status: SEEDING_STATUS, startedAt: GAP_START, endedAt: END })
    // Un replay escribe un punto por vela de 15 min (al cierre: slot + 15 min − 1): un día entero.
    await t.repos.equity.insert(GAP_REPLAY, Array.from({ length: 96 }, (_, i) => curvePoint(GAP_START + (i + 1) * 15 * MIN - 1, 1000 + i)))
    // El vivo, uno por minuto, con un salto de 7 minutos en el medio.
    const minutes = [...Array.from({ length: 30 }, (_, i) => i), ...Array.from({ length: 30 }, (_, i) => 36 + i)]
    await t.repos.equity.insert(GAP_LIVE, minutes.map((m) => curvePoint(GAP_START + m * MIN, 1000 + m)))
    await archiveSeeded(t, GAP_REPLAY, END)
    await archiveSeeded(t, GAP_LIVE, END)
  })

  it('el replay escribe de a 15 minutos y el vivo de a 1', () => {
    expect(equityNativeMs('replay')).toBe(15 * MIN)
    expect(equityNativeMs('paper_live')).toBe(MIN)
  })

  it('una curva de replay de 15 minutos no tiene huecos, ni con todos los puntos ni por tramos', async () => {
    const native = equityNativeMs('replay')
    const all = await equitySeries(t.db, GAP_REPLAY, GAP_START, END, 0, native)
    expect(all).toHaveLength(96)
    expect(all.filter((p) => p.gapBefore)).toEqual([])
    // Tramos de 62 min (los de "Todo" en 30 días): los últimos puntos caen a 60 o 75 min.
    const bucketed = await equitySeries(t.db, GAP_REPLAY, GAP_START, END, 62 * MIN, native)
    expect(bucketed.length).toBeGreaterThan(20)
    expect(bucketed.filter((p) => p.gapBefore)).toEqual([])
  })

  it('una curva en vivo de 1 minuto marca un solo hueco en el salto de 7 minutos', async () => {
    const points = await equitySeries(t.db, GAP_LIVE, GAP_START, END, 0, equityNativeMs('paper_live'))
    expect(points.filter((p) => p.gapBefore).map((p) => p.at)).toEqual([GAP_START + 36 * MIN])
  })
})

describe('getPosicionesData', () => {
  it('filtra el historial por los parámetros de la URL', async () => {
    const data = await getPosicionesData(SESSION, parsePosicionesQuery({ liquidadas: '1' }))
    expect(data?.closed.items.map((c) => c.id)).toEqual(['q-liq'])
    expect(data?.closed.symbols).toEqual(['DOGEUSDT', 'ETHUSDT', 'SOLUSDT'])
  })

  it('trae el detalle del trade de `?trade=` con sus señales y pesos', async () => {
    const trade = (await getPosicionesData(SESSION, { trade: 'q-won1' }))?.trade
    expect(trade?.closed).toBe(true)
    expect(trade?.signals).toEqual([
      { id: 'trend15m', value: 0.6, weight: 1.5 },
      { id: 'momentum', value: -0.2, weight: 1 },
    ])
    const open = (await getPosicionesData(SESSION, { trade: 'q-open' }))?.trade
    expect(open?.closed).toBe(false)
    expect(open?.events.map((e) => e.kind)).toEqual(['stop_moved', 'funding', 'funding'])
    expect((await getPosicionesData(SESSION, { trade: 'q-shadow' }))?.trade).toBeNull()
  })

  it('ignora parámetros inválidos en lugar de romper la pantalla', () => {
    expect(parsePosicionesQuery({ moneda: 'SOLUSDT', lado: 'izquierda', pagina: '2', liquidadas: ['1', '0'] })).toEqual({
      moneda: 'SOLUSDT',
      pagina: 2,
      liquidadas: '1',
    })
  })
})

describe('getMonedasData', () => {
  it('cada moneda del tablero con su última decisión, aprendizaje y estadísticas', async () => {
    const coins = (await getMonedasData(SESSION))?.coins
    expect(Object.keys(coins ?? {}).sort()).toEqual(['DOGEUSDT', 'ETHUSDT', 'SOLUSDT'])
    expect(coins?.SOLUSDT).toMatchObject({
      name: 'SOL',
      decision: { action: 'blocked:low_volume', Sprime: 0.4 },
      confidence: 0.3,
      multiplier: 1,
      stats: { trades: 1, wins: 1, pnlNet: 9.5, winRate: 1 },
      penaltyUntil: null,
    })
    // Mismo K de los ajustes que la hoja del trade: la misma moneda muestra el mismo peso.
    expect(coins?.SOLUSDT?.weights.trend15m).toBe(1.5)
    expect(coins?.DOGEUSDT).toMatchObject({ penaltyUntil: PENALTY_UNTIL, multiplier: 0.5, confidence: -0.45 })
  })

  it('las monedas que quedaron afuera del último universo del día, con su motivo', async () => {
    expect((await getMonedasData(SESSION))?.excluded).toEqual({
      NEWUSDT: { reason: 'history', detail: '2026-10-15', pinned: true },
      XAUUSDT: { reason: 'tradfi' },
    })
  })
})

describe('getAprendizajeData', () => {
  it('progreso, fiabilidad y acierto por señal, parámetros y comparación con la sombra', async () => {
    const data = await getAprendizajeData(SESSION)
    expect(data?.progress).toEqual({ closedTrades: 3, minTrades: 50, collecting: true })
    const trend = data?.signals.find((s) => s.id === 'trend15m')
    expect(trend?.reliability.n).toBe(12)
    expect(trend?.reliability.rho).toBeCloseTo(1, 9)
    expect(trend?.hitRate).toBeCloseTo(2 / 3, 9)
    const momentum = data?.signals.find((s) => s.id === 'momentum')
    // Valor constante: sin varianza no hay correlación.
    expect(momentum?.reliability).toEqual({ rho: null, n: 12 })
    expect(momentum?.hitRate).toBe(0)
    expect(data?.params.lastChangeAt).toBe(END - 2 * DAY)
    expect(data?.params.rejected.map((r) => r.text)).toEqual(['Rechacé k 2,0.', 'Rechacé θ 0,45.'])
    expect(data?.coins.find((c) => c.symbol === 'DOGEUSDT')).toMatchObject({ trades: 9, penaltyUntil: PENALTY_UNTIL })
    // 1.000 → 1.050 lo aprendido y 1.000 → 1.040 la sombra: la sombra va 1 punto abajo.
    expect(data?.shadow?.comparison.gapPp).toBeCloseTo(-1, 9)
    expect(data?.shadow?.comparison.warn).toBe(false)
    expect(data?.sessions.some((s) => s.session.id === SESSION)).toBe(false)
  })

  it('en una simulación de menos de 14 días la sombra se compara desde I₀, no desde el primer punto', async () => {
    await seedSession(t, SHADOW_SESSION, { startedAt: START, endedAt: END })
    const point = (at: number, equity: number, shadowEquity: number) => ({
      at,
      saldo: equity,
      equity,
      margenEnUso: 0,
      protegido: 0,
      capitalBase: equity,
      capitalOperable: equity,
      shadowEquity,
      kind: 'event' as const,
    })
    await t.repos.equity.insert(SHADOW_SESSION, [point(START + HOUR, 1010, 1005), point(END - HOUR, 1030, 1020)])
    const comparison = (await getAprendizajeData(SHADOW_SESSION))?.shadow?.comparison
    // 1.000 → 1.030 y 1.000 → 1.020; desde el primer punto serían 2 y 1,5.
    expect(comparison?.learnedPp).toBeCloseTo(3, 9)
    expect(comparison?.shadowPp).toBeCloseTo(2, 9)
  })
})

describe('getAjustesData', () => {
  it('ajustes con su versión, historia y monedas fuera por mínimo', async () => {
    const data = await getAjustesData(SESSION)
    expect(data?.settings?.version).toBe(3)
    expect(data?.history.map((h) => h.version)).toEqual([3, 2, 1])
    expect(data?.universe.current).toEqual(['SOLUSDT', 'ETHUSDT', 'DOGEUSDT'])
    expect(data?.universe.belowMinimum).toEqual(['ETHUSDT'])
    expect(data?.defaults).toEqual(DEFAULT_SETTINGS)
  })

  it('Universo dice qué monedas quedan fuera y por qué, incluido el mínimo de Binance con el capital actual', async () => {
    const data = await getAjustesData(SESSION)
    expect(data?.universe.excluded).toEqual({
      NEWUSDT: { reason: 'history', detail: '2026-10-15', pinned: true },
      XAUUSDT: { reason: 'tradfi' },
      // El mínimo del contrato, para "mínimo de Binance (US$ 20) mayor que lo que permite tu capital".
      ETHUSDT: { reason: 'below_min_notional', detail: '20' },
    })
  })
})
