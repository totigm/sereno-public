// @vitest-environment node
import { describe, expect, it } from 'vitest'
// El contrato de `position_events.payload` lo fija el bot: el generador tiene que escribir lo mismo.
import { fundingEvent } from '../../../bot/src/live/payloads'
import { cents, type BookResult } from '../../scripts/demo/book'
import type { DemoDataset, DemoSession } from '../../scripts/demo/dataset'
import { buildDataset, type ScenarioName } from '../../scripts/demo/scenario'
import { activeSpec, hoursAgo } from '../../scripts/demo/scenarios/active'
import { sessionSummary } from '../../scripts/demo/summary'
import { alignDown, CYCLE_MS, DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, STALE_DATA_MS } from '../../scripts/demo/time'
import { buildWorld } from '../../scripts/demo/world'

const NOW = Date.parse('2026-10-31T23:41:12Z')
const SEED = 20261031
const OWNER = 'toti@example.com'

const cache = new Map<string, DemoDataset>()
function dataset(name: ScenarioName, now = NOW, seed = SEED): DemoDataset {
  const key = `${name}|${now}|${seed}`
  let found = cache.get(key)
  if (!found) {
    found = buildDataset(name, { seed, now, ownerEmail: OWNER })
    cache.set(key, found)
  }
  return found
}

function live(name: ScenarioName): DemoSession & { books: { real: BookResult; shadow: BookResult } } {
  const session = dataset(name).sessions[0]
  if (!session?.books) throw new Error(`${name} no tiene simulación en vivo`)
  return session as DemoSession & { books: { real: BookResult; shadow: BookResult } }
}

const closedOf = (book: BookResult) => book.positions.flatMap((p) => (p.closed ? [p.closed] : []))
const openOf = (book: BookResult) => book.positions.filter((p) => p.closed === null).map((p) => p.position)
const isCents = (x: number): boolean => Math.abs(Math.round(x * 100) - x * 100) < 1e-6

// Hasta cuándo llega cada sesión: el último latido en vivo, el pedido en un replay.
function sessionEnd(s: DemoSession): number {
  const heartbeat = s.bot?.status.lastHeartbeat
  if (heartbeat instanceof Date) return heartbeat.getTime()
  return (s.row.startedAt as Date).getTime()
}

// Todo lo que una sesión fecha: aperturas, cierres, eventos, curva, decisiones y aprendizaje.
function stampsOf(s: DemoSession): { what: string; at: number }[] {
  const out: { what: string; at: number }[] = []
  for (const book of s.books ? [s.books.real, s.books.shadow] : []) {
    for (const p of book.positions) {
      out.push({ what: `${p.position.id} abre`, at: p.position.openedAt })
      if (p.closed) out.push({ what: `${p.position.id} cierra`, at: p.closed.closedAt })
      for (const e of p.events) out.push({ what: `${p.position.id} ${e.kind}`, at: e.at })
    }
  }
  for (const p of s.equity) out.push({ what: `equity ${p.kind}`, at: p.at })
  for (const d of s.decisions) out.push({ what: `decisión ${d.symbol}`, at: d.t })
  for (const l of s.learning?.log ?? []) out.push({ what: `aprendizaje ${l.kind}`, at: l.at })
  return out
}

function lateStamps(ds: DemoDataset): string[] {
  return ds.sessions.flatMap((s) => {
    const end = sessionEnd(s)
    return stampsOf(s)
      .filter((x) => x.at > end)
      .map((x) => `${s.row.id}: ${x.what} ${x.at - end} ms después de ${new Date(end).toISOString()}`)
  })
}

// Cuánto hace que FIL no manda datos según la baldosa, medido desde el último latido.
function filStaleness(s: DemoSession): { since: number; age: number } {
  const fil = s.marketSnapshot?.symbols.find((v) => v.symbol === 'FILUSDT')
  const since = Date.parse(fil?.staleSince ?? '')
  return { since, age: (s.bot?.status.lastHeartbeat as Date).getTime() - since }
}

const candlesOf = (ds: DemoDataset, symbol: string, timeframe = '15m') =>
  ds.candles.find((c) => c.key.symbol === symbol && c.key.timeframe === timeframe && c.key.priceType === 'last')?.items ?? []

// Lo esencial de un escenario, sin el mercado (arreglos tipados enormes).
function digest(ds: DemoDataset): string {
  return JSON.stringify(ds.sessions.map((s) => ({ row: s.row, books: s.books, decisions: s.decisions, equity: s.equity, snapshot: s.marketSnapshot, bot: s.bot })))
}

// Cada escenario arma un mercado de ~110 días para 30 monedas: con otros procesos en la
// máquina, un test que arma varios pasa los 5 s por defecto.
describe('generador de datos de demostración', { timeout: 60_000 }, () => {
  it('es determinista: misma semilla y mismo ahora, mismos datos', () => {
    const a = buildDataset('active', { seed: SEED, now: NOW, ownerEmail: OWNER })
    const b = buildDataset('active', { seed: SEED, now: NOW, ownerEmail: OWNER })
    expect(digest(a)).toBe(digest(b))
    expect(JSON.stringify(a.candles.slice(0, 4))).toBe(JSON.stringify(b.candles.slice(0, 4)))
  })

  it('otra semilla da otros precios con la misma historia', () => {
    const other = dataset('active', NOW, SEED + 1).sessions[0]
    const real = other?.books?.real
    expect(real && closedOf(real).length).toBe(23)
    expect(digest(dataset('active', NOW, SEED + 1))).not.toBe(digest(dataset('active')))
  })

  it.each([Date.parse('2026-10-31T00:00:30Z'), Date.parse('2026-11-01T07:13:59Z'), Date.parse('2026-11-02T15:59:59Z')])(
    'arma la misma historia para cualquier ahora (%i)',
    (now) => {
      const s = dataset('active', now).sessions[0]
      const real = s?.books?.real
      if (!real) throw new Error('sin cartera')
      expect(closedOf(real)).toHaveLength(23)
      expect(openOf(real)).toHaveLength(3)
    },
  )

  describe('justo en el cierre de una vela', () => {
    const cases: [ScenarioName, string][] = [
      // El último latido cae exacto en el cierre de las 12:00.
      ['active', '2026-11-01T12:00:05.000Z'],
      // 1,5 s después del cierre: las órdenes de ese ciclo todavía están saliendo.
      ['active', '2026-11-01T12:00:06.500Z'],
      // Una vela abierta de casi 15 minutos.
      ['active', '2026-11-01T12:14:59.000Z'],
      ['shielded', '2026-11-01T12:00:05.000Z'],
      ['offline', '2026-11-01T12:12:00.000Z'],
      ['replays', '2026-11-01T12:00:05.000Z'],
    ]
    it.each(cases)('%s con ahora %s: nada queda fechado después del último latido', (name, iso) => {
      const ds = dataset(name, Date.parse(iso))
      expect(lateStamps(ds)).toEqual([])
      const real = ds.sessions[0]?.books?.real
      expect(real && closedOf(real).length).toBe(name === 'shielded' ? 36 : 23)
    })

    it('a lo largo de un ciclo entero el último ciclo guardado ya terminó de ejecutar: entra, espera y bloquea', () => {
      const boundary = Date.parse('2026-11-01T12:00:00Z')
      for (const offset of [0, 900, 1800, 3200, 4999, 5000, 5001, 60_000, 540_000, 899_999]) {
        const ds = dataset('active', boundary + offset + 5 * SECOND_MS)
        expect(lateStamps(ds)).toEqual([])
        const decisions = ds.sessions[0]?.decisions ?? []
        const lastCycle = Math.max(...decisions.map((d) => d.t))
        const latest = decisions.filter((d) => d.t === lastCycle)
        expect(new Set(latest.map((d) => d.action.kind))).toEqual(new Set(['enter', 'wait', 'blocked']))
        const { age } = filStaleness(ds.sessions[0] as DemoSession)
        expect(age).toBeGreaterThanOrEqual(3 * MINUTE_MS)
        expect(age).toBeLessThan(4 * MINUTE_MS)
      }
    })
  })

  describe('FIL sin datos hace 3 minutos con cualquier ahora', () => {
    const cases: [ScenarioName, string, boolean][] = [
      // Un minuto después del cierre: para ese ciclo FIL ya llevaba dos minutos sin datos.
      ['active', '2026-11-01T12:01:05.000Z', true],
      // Once minutos después: en el último ciclo FIL todavía mandaba datos.
      ['active', '2026-10-31T23:41:12.000Z', false],
      ['active', '2026-11-01T12:14:59.000Z', false],
      ['shielded', '2026-11-01T12:01:05.000Z', true],
    ]
    it.each(cases)('%s con ahora %s: la baldosa, el latido y la decisión del último ciclo coinciden', (name, iso, staleAtCycle) => {
      const now = Date.parse(iso)
      const s = dataset(name, now).sessions[0] as DemoSession
      const { since, age } = filStaleness(s)
      expect(age).toBe(3 * MINUTE_MS)
      expect(now - since).toBeGreaterThanOrEqual(3 * MINUTE_MS)
      expect(now - since).toBeLessThan(4 * MINUTE_MS)
      expect(s.bot?.status.degradedSymbols).toEqual(['FILUSDT'])
      expect(s.bot?.status.recentErrors[0]?.at).toBe(new Date(since).toISOString())
      const lastCycle = Math.max(...s.decisions.map((d) => d.t))
      // El ciclo ve degradada a la moneda que lleva más de un minuto sin datos, como el bot.
      expect(lastCycle - since > STALE_DATA_MS).toBe(staleAtCycle)
      const fil = s.decisions.find((d) => d.t === lastCycle && d.symbol === 'FILUSDT')
      const reason = fil?.action.kind === 'blocked' ? fil.action.reason : null
      if (staleAtCycle) expect(reason).toBe('degraded')
      else expect(reason).not.toBe('degraded')
    })
  })

  describe('active', () => {
    const s = live('active')
    const { real, shadow } = s.books

    it('16 días con US$ 1.000: 23 cerradas (14 ganadas) y 3 abiertas', () => {
      expect(s.row.capitalInicial).toBe(1000)
      expect(s.row.status).toBe('active')
      expect(NOW - (s.row.startedAt as Date).getTime()).toBeGreaterThan(16 * DAY_MS)
      expect(NOW - (s.row.startedAt as Date).getTime()).toBeLessThan(17 * DAY_MS)
      const closed = closedOf(real)
      expect(closed).toHaveLength(23)
      expect(closed.filter((c) => c.pnlNet > 0)).toHaveLength(14)
      expect(openOf(real)).toHaveLength(3)
    })

    it('cierra por stop, take profit, trailing, señal, tiempo y a mano', () => {
      const reasons = new Set(closedOf(real).map((c) => c.closeReason))
      expect([...reasons].sort()).toEqual(['manual', 'signal_flip', 'stop', 'take_profit', 'time_exit', 'trailing_stop'])
    })

    it('las abiertas: largo y corto, 2x a 5x, dos ganando y una perdiendo, con stop y take profit', () => {
      const open = openOf(real)
      expect(new Set(open.map((p) => p.side))).toEqual(new Set(['long', 'short']))
      expect(open.map((p) => p.leverage).sort()).toEqual([2, 3, 5])
      const lastPrice = (symbol: string) => s.marketSnapshot?.symbols.find((v) => v.symbol === symbol)?.markPrice ?? Number.NaN
      const pnl = open.map((p) => (lastPrice(p.symbol) - p.entryPrice) * p.qty * (p.side === 'long' ? 1 : -1))
      expect(pnl.filter((x) => x > 0)).toHaveLength(2)
      expect(pnl.filter((x) => x < 0)).toHaveLength(1)
      for (const p of open) {
        expect(p.stopOrderId).toBeTruthy()
        expect(p.tpOrderId).toBeTruthy()
        expect(p.takeProfitPrice).not.toBeNull()
      }
    })

    it('saldo = I₀ + Σ pnl neto de las cerradas − costos ya pagados de las abiertas', () => {
      for (const book of [real, shadow]) {
        const closed = closedOf(book)
        const open = openOf(book)
        const expected = 1000 + closed.reduce((a, c) => a + c.pnlNet, 0) - open.reduce((a, p) => a + p.feesPaid + p.fundingPaid, 0)
        expect(book.final.saldo).toBeCloseTo(expected, 6)
        expect(book.final.equity).toBeCloseTo(book.final.saldo + book.final.unrealized, 9)
      }
    })

    it('R = pnl neto / riesgo real y pnl neto = bruto − comisiones − funding, en centavos', () => {
      for (const c of [...closedOf(real), ...closedOf(shadow)]) {
        expect(c.rMultiple).toBeCloseTo(c.pnlNet / c.riesgoReal, 12)
        expect(c.pnlNet).toBeCloseTo(c.pnlGross - c.feesPaid - c.fundingPaid, 9)
        for (const x of [c.pnlNet, c.pnlGross, c.feesPaid, c.fundingPaid, c.margin, c.riesgoReal]) expect(isCents(x)).toBe(true)
      }
    })

    it('funding: el payload sigue el contrato del bot (positivo = pagado, como fundingPaid)', () => {
      let events = 0
      for (const { position, closed, events: list } of [...real.positions, ...shadow.positions]) {
        const funding = list.filter((e) => e.kind === 'funding')
        const paid = funding.reduce((sum, e) => sum + (e.payload['amount'] as number), 0)
        expect(paid).toBeCloseTo((closed ?? position).fundingPaid, 9)
        for (const e of funding) {
          const { rate, markPrice } = e.payload as { rate: number; markPrice: number }
          // Lo que informaría el motor (positivo = cobrado) pasado por la función de payloads del bot.
          const received = cents(-(position.side === 'long' ? 1 : -1) * position.qty * markPrice * rate)
          expect(e.payload['amount']).toBe(fundingEvent({ type: 'funding_applied', positionId: position.id, amount: received, at: e.at }).payload['amount'])
          events++
        }
      }
      expect(events).toBeGreaterThan(0)
    })

    it('la sombra opera en paralelo con sus propias posiciones', () => {
      expect(real.positions.every((p) => !p.position.shadow)).toBe(true)
      expect(shadow.positions.every((p) => p.position.shadow)).toBe(true)
      expect(closedOf(shadow)).toHaveLength(23)
      // Los cierres a mano de Toti no se copian: la sombra los lleva a su salida.
      expect(closedOf(shadow).some((c) => c.closeReason === 'manual')).toBe(false)
    })

    it('curva: un punto por minuto en las últimas 24 h, uno por hora antes, y termina en el equity de ahora', () => {
      const minute = s.equity.filter((p) => p.kind === 'minute')
      const end = NOW - 5_000
      const recent = minute.filter((p) => p.at > end - DAY_MS)
      expect(recent.length).toBeGreaterThanOrEqual(1439)
      const older = minute.filter((p) => p.at <= end - DAY_MS - HOUR_MS)
      for (const [i, p] of older.entries()) if (i > 0) expect(p.at - (older[i - 1]?.at ?? 0)).toBe(HOUR_MS)
      // El último minuto cerrado: el saldo es el de ahora y el equity, el de unos segundos antes.
      const last = minute[minute.length - 1]
      expect(last?.saldo).toBeCloseTo(real.final.saldo, 6)
      expect(Math.abs((last?.equity ?? 0) - real.final.equity)).toBeLessThan(1)
      expect(Math.abs((last?.shadowEquity ?? 0) - shadow.final.equity)).toBeLessThan(1)
      for (const p of s.equity) expect(p.capitalOperable).toBeCloseTo(Math.max(0, p.capitalBase - p.margenEnUso), 1)
    })

    it('universo de 30 monedas con penitencia, enfriamiento y una sin datos hace 3 minutos', () => {
      const views = s.marketSnapshot?.symbols ?? []
      expect(views).toHaveLength(30)
      const state = (symbol: string) => views.find((v) => v.symbol === symbol)
      expect(state('WIFUSDT')?.state).toBe('penalized')
      expect(state('NEARUSDT')?.state).toBe('cooldown')
      const fil = state('FILUSDT')
      expect(fil?.state).toBe('degraded')
      expect(filStaleness(s).age).toBe(3 * MINUTE_MS)
      expect(views.filter((v) => v.state === 'in_position')).toHaveLength(3)
      expect(state('BTCUSDT')?.markPrice).toBeGreaterThan(60_000)
      expect(state('BTCUSDT')?.markPrice).toBeLessThan(85_000)
      expect(s.universe.at(-1)?.symbols).toHaveLength(30)
    })

    it('bot vivo: latido de hace 5 segundos y fase live', () => {
      expect(NOW - (s.bot?.status.lastHeartbeat as Date).getTime()).toBe(5_000)
      expect(s.bot?.status.phase).toBe('live')
      expect(s.bot?.status.degradedSymbols).toEqual(['FILUSDT'])
      expect(s.bot?.status.settingsVersionApplied).toBe(s.settings.at(-1)?.version)
      // Como el bot: el último ciclo es el cierre de vela que decidió.
      expect((s.bot?.status.lastCycleAt as Date).getTime()).toBe(Math.max(...s.decisions.map((d) => d.t)))
    })

    it('decisiones de las últimas 24 h: entrar, esperar y bloqueos con motivos variados y señales sin dato', () => {
      const lastCycle = Math.max(...s.decisions.map((d) => d.t))
      expect(lastCycle % CYCLE_MS).toBe(0)
      const latest = s.decisions.filter((d) => d.t === lastCycle)
      expect(latest).toHaveLength(30)
      const kinds = new Set(latest.map((d) => d.action.kind))
      expect(kinds).toEqual(new Set(['enter', 'wait', 'blocked']))
      const reasons = new Set(latest.flatMap((d) => (d.action.kind === 'blocked' ? [d.action.reason] : [])))
      for (const r of ['penalty', 'cooldown', 'has_position', 'stop_too_small_for_cost', 'higher_trend_against', 'low_volume']) expect(reasons).toContain(r)
      expect(s.decisions.some((d) => d.composite.signals.some((sig) => sig.value === null))).toBe(true)
      expect(s.decisions.filter((d) => d.t <= lastCycle - 4 * HOUR_MS).every((d) => s.forwardReturns.has(`${d.symbol}|${d.t}`))).toBe(true)
    })

    it('aprendizaje juntando datos: 23 de 50 y la penitencia de WIF en el diario', () => {
      expect(s.learning?.state.closedTrades).toBe(23)
      expect(s.learning?.log.some((l) => l.kind === 'penalty' && l.symbol === 'WIFUSDT')).toBe(true)
    })

    it('ajustes con historia de cambios firmados por el dueño', () => {
      expect(s.settings.length).toBeGreaterThan(1)
      expect(s.settings.map((v) => v.version)).toEqual(s.settings.map((_, i) => i + 1))
      expect(s.settings.every((v) => v.by === OWNER)).toBe(true)
    })

    it('estadísticas y veredicto por cartera, sin mezclarlas', () => {
      const summary = sessionSummary(s, SEED, NOW)
      expect(summary?.real.stats.trades).toBe(23)
      expect(summary?.real.stats.wins).toBe(14)
      expect(summary?.real.verdict.status).toBe('insufficient')
      expect(summary?.real.verdict.reason).toContain('faltan 77')
    })
  })

  it('shielded: ganancia sobre el 70%, blindaje activo con lo protegido igual a la base y una reducción', () => {
    const s = live('shielded')
    const { real } = s.books
    expect(real.shield).not.toBeNull()
    expect(s.row.protegido).toBe(1000)
    expect(s.row.baseBlindaje).toBe(1000)
    expect(real.final.protegido).toBe(real.final.baseBlindaje)
    expect(real.final.saldo - 1000).toBeGreaterThanOrEqual(700)
    expect(real.final.capitalBase).toBeCloseTo(real.final.saldo - 1000, 9)
    expect(closedOf(real).filter((c) => c.closeReason === 'shield_reduce')).toHaveLength(1)
    const lastPoint = s.equity.at(-1)
    expect(lastPoint?.protegido).toBe(1000)
  })

  it('shielded: después del blindaje el tamaño se calcula con el capital de ese momento', () => {
    const s = live('shielded')
    const shieldAt = s.books.real.shield?.at ?? Number.POSITIVE_INFINITY
    const maxMarginPerTrade = s.settings.at(-1)?.config.risk.maxMarginPerTrade ?? 1
    const noCapital = s.decisions.filter((d) => d.t >= shieldAt && d.action.kind === 'blocked' && d.action.reason === 'insufficient_capital')
    expect(noCapital.length).toBeGreaterThan(0)
    for (const d of noCapital) {
      // Sólo falta capital cuando lo operable no llega al margen máximo de un trade.
      const point = s.equity.filter((p) => p.at <= d.t).at(-1)
      expect(point?.capitalBase).toBeLessThan(1000)
      expect(point?.capitalOperable).toBeLessThan(maxMarginPerTrade * (point?.capitalBase ?? 0))
    }
  })

  it('offline: la misma simulación con el último latido hace 12 minutos', () => {
    const s = live('offline')
    expect(NOW - (s.bot?.status.lastHeartbeat as Date).getTime()).toBe(12 * MINUTE_MS)
    expect((s.bot?.lease.leaseUntil as Date).getTime()).toBeLessThan(NOW)
    expect(s.marketSnapshot?.updatedAt).toBe(NOW - 12 * MINUTE_MS)
    expect(closedOf(s.books.real)).toHaveLength(23)
  })

  describe('replays', () => {
    it('uno terminado con reporte y veredicto, uno corriendo y uno en cola', () => {
      const sessions = dataset('replays').sessions
      expect(sessions.map((s) => `${s.row.kind}:${s.row.status}`)).toEqual(['paper_live:active', 'replay:listo', 'replay:simulando', 'replay:en_cola'])
      const done = sessions[1]
      if (!done?.books) throw new Error('el replay terminado no tiene carteras')
      const summary = sessionSummary(done, SEED, NOW)
      expect(summary?.real.stats.trades).toBeGreaterThanOrEqual(100)
      expect(summary?.real.verdict.status).not.toBe('insufficient')
      expect(done.row.mensaje).toBe(summary?.real.verdict.reason)
      expect(done.row.replayParams?.days).toBe(90)
      expect(done.row.progreso).toBe(1)
      expect(done.equity.every((p) => p.kind === 'event' || p.at % HOUR_MS === 0)).toBe(true)
      const running = sessions[2]
      expect(running?.row.progreso).toBeCloseTo(41 / 90, 9)
      expect(running?.row.mensaje).toBe('Simulando · día 41 de 90')
      expect(sessions[3]?.row.replayParams).toEqual({ days: 30, capital: 2000, learningOrigin: 'zero', paramTuning: true })
    })

    const ds = dataset('replays')
    const done = ds.sessions[1]
    if (!done?.books) throw new Error('el replay terminado no tiene carteras')
    const replayReal = done.books.real
    const replaySymbols = [...new Set(done.decisions.map((d) => d.symbol))]
    const replayStart = Math.min(...done.decisions.map((d) => d.t)) - CYCLE_MS
    const replayEnd = Math.max(...done.decisions.map((d) => d.t))

    it('la simulación en vivo es la misma que en active: el replay comparte el mercado sin cambiarla', () => {
      expect(JSON.stringify(ds.sessions[0]?.books)).toBe(JSON.stringify(live('active').books))
    })

    it('el replay terminado guarda todas sus decisiones: cada ciclo de los 90 días por moneda, con sus retornos', () => {
      expect(replaySymbols).toHaveLength(12)
      expect(replayEnd - replayStart).toBe(90 * DAY_MS)
      expect(new Set(done.decisions.map((d) => d.t)).size).toBe(90 * 96)
      expect(done.decisions).toHaveLength(90 * 96 * 12)
      expect(new Set(done.decisions.map((d) => d.action.kind))).toEqual(new Set(['enter', 'wait', 'blocked']))
      expect(done.decisions.filter((d) => d.action.kind === 'enter')).toHaveLength(replayReal.positions.length)
      for (const d of done.decisions) {
        const fr = done.forwardReturns.get(`${d.symbol}|${d.t}`)
        expect(typeof fr?.forwardReturn4h).toBe(d.t + 4 * HOUR_MS <= replayEnd ? 'number' : 'undefined')
        expect(typeof fr?.forwardReturn24h).toBe(d.t + DAY_MS <= replayEnd ? 'number' : 'undefined')
      }
      // Material para el histograma de S′: esperas cerca de cero y señales que pasan θ.
      const passing = done.decisions.filter((d) => Math.abs(d.composite.Sprime) >= 0.35)
      expect(passing.length).toBeGreaterThan(done.decisions.length / 100)
    })

    it('las velas del replay quedan en la base, continuas desde antes del replay hasta ahora', () => {
      for (const symbol of replaySymbols) {
        const items = candlesOf(ds, symbol)
        expect(items[0]?.openTime).toBeLessThan(replayStart)
        for (const [i, c] of items.entries()) if (i > 0) expect(c.openTime - (items[i - 1]?.openTime ?? 0)).toBe(CYCLE_MS)
        expect(candlesOf(ds, symbol, '4h')[0]?.openTime).toBeLessThan(replayStart)
      }
    })

    it('cada posición abre al cierre de la vela que se dibuja debajo, en el replay y en vivo', () => {
      for (const s of ds.sessions.slice(0, 2)) {
        for (const p of [...(s.books?.real.positions ?? []), ...(s.books?.shadow.positions ?? [])]) {
          const decidedAt = alignDown(p.position.openedAt, CYCLE_MS)
          const candle = candlesOf(ds, p.position.symbol).find((c) => c.closeTime + 1 === decidedAt)
          const open = p.events.find((e) => e.kind === 'open')
          expect(candle?.close).toBeCloseTo(Number(open?.payload.lastPrice), 9)
        }
      }
    })

    it('el replay termina con su foto del mercado y su universo, como la deja el bot', () => {
      const views = done.marketSnapshot?.symbols ?? []
      expect(views.map((v) => v.symbol).sort()).toEqual([...replaySymbols].sort())
      expect(done.marketSnapshot?.updatedAt).toBe(replayEnd)
      for (const v of views) {
        const candle = candlesOf(ds, v.symbol).find((c) => c.closeTime + 1 === replayEnd)
        expect(v.markPrice).toBeCloseTo(candle?.close ?? Number.NaN, 9)
      }
      expect(done.universe).toHaveLength(91)
      expect(done.universe[0]?.symbols).toHaveLength(12)
    })
  })

  it('rechaza un escenario que haría algo que el bot nunca hace', () => {
    const botSeenAt = NOW - 5_000
    const ago = hoursAgo(botSeenAt)
    const spec = activeSpec({ botSeenAt, ownerEmail: OWNER })
    // WIF está en penitencia desde la racha de stops: el bot no abriría ahí.
    spec.trades.push({ id: 'x', symbol: 'WIFUSDT', side: 'long', open: ago(20), exit: { kind: 'take_profit', at: ago(12) }, strength: 0.5 })
    expect(() => buildWorld({ seed: SEED, botSeenAt, live: spec, replays: [], saveReplays: false })).toThrow(/penitencia/)
  })

  it('rechaza una entrada en un ciclo que todavía estaba ejecutando cuando el bot escribió', () => {
    const boundary = Date.parse('2026-11-01T12:00:00Z')
    const botSeenAt = boundary + SECOND_MS
    const spec = activeSpec({ botSeenAt, ownerEmail: OWNER })
    spec.trades.push({ id: 'x', symbol: 'TONUSDT', side: 'long', open: boundary, exit: { kind: 'open', r: 0.2 }, strength: 0.5 })
    expect(() => buildWorld({ seed: SEED, botSeenAt, live: spec, replays: [], saveReplays: false })).toThrow(/no terminó de ejecutar/)
  })

  describe('real', () => {
    const real = () => dataset('real').sessions[1]

    it('la simulación sigue igual y al lado corre la sesión real de US$ 100 en testnet, sin sombra', () => {
      expect(digest({ ...dataset('real'), sessions: [live('real')] })).toBe(digest({ ...dataset('active'), sessions: [live('active')] }))
      const s = real()
      expect(s?.row).toMatchObject({ kind: 'live', status: 'active', capitalInicial: 100, binanceEnv: 'testnet', realStatus: 'on' })
      expect(s?.books?.shadow.positions).toEqual([])
      expect(s?.bot?.status.real).toEqual({ mode: 'trading', missing: [] })
      expect(closedOf(s?.books?.real as BookResult).length).toBeGreaterThan(0)
      expect(openOf(s?.books?.real as BookResult).length).toBeGreaterThan(0)
      expect(lateStamps(dataset('real'))).toEqual([])
    })

    it('los números de las posiciones vienen de Binance y hay diferencias de reconciliación en el diario', () => {
      const events = (real()?.books?.real.positions ?? []).flatMap((p) => p.events)
      expect(events.filter((e) => e.kind === 'open' || e.kind === 'close').every((e) => e.payload.reported === true)).toBe(true)
      expect(real()?.realEvents?.map((e) => e.kind)).toEqual(['foreign_position', 'reconciled'])
      expect(dataset('real').readiness).toMatchObject({ env: 'testnet', enabled: true, keysPresent: true })
    })

    it('real-floor: apagada por el tope, con chequeos viejos y la hora corrida', () => {
      const s = dataset('real-floor').sessions[1]
      expect(s?.row.realStatus).toBe('loss_floor')
      expect(s?.bot?.status.real?.mode).toBe('reduce_only')
      const readiness = dataset('real-floor').readiness
      expect(NOW - (readiness?.checkedAt ?? NOW)).toBeGreaterThan(15 * MINUTE_MS)
      expect(readiness?.checks.find((c) => c.id === 'clock')?.status).toBe('fail')
    })
  })

  it('first-run: ninguna simulación', () => {
    const ds = dataset('first-run')
    expect(ds.sessions).toHaveLength(0)
    expect(ds.candles).toHaveLength(0)
  })
})
