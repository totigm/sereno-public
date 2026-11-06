import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Scorer } from '@sereno/core/src/engine/types'
import { DAY_MS } from '@sereno/core/src/replay/clock'
import type { SessionRow } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import { FakeBinance } from '../../src/binance/fake/server'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget } from '../../src/jobs/budget'
import { silentLogger } from '../../src/logger'
import { replayPeriod } from '../../src/replay/period'
import { runReplaySession } from '../../src/replay/run'
import { restFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'
import { fixedScorer, TWO_COINS } from '../helpers/live'

const NOW = Date.UTC(2026, 9, 31, 12, 7)
const PERIOD = replayPeriod(3, NOW)

let fake: FakeBinance
let t: TestDb
const created: string[] = []

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await t.query('delete from sessions where id = any($1)', [created])
  await fake.stop()
  await t.close()
})

beforeEach(() => {
  fake.reset()
})

async function requestReplay(settings: Settings = TWO_COINS, learning: 'zero' | 'current' = 'zero'): Promise<SessionRow> {
  const row = await t.repos.sessions.createReplay({
    name: 'Replay de prueba T21',
    capitalInicial: 1000,
    settings,
    learningOrigin: learning === 'zero' ? 'zero' : 'continued',
    replayParams: { days: 3, capital: 1000, learningOrigin: learning, paramTuning: false },
  })
  created.push(row.id)
  return row
}

function deps(scorer: Scorer) {
  return { db: t.db, rest: restFor(fake, NOW).rest, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW), logger: silentLogger, now: () => NOW, scorer }
}

describe('runReplaySession', () => {
  it('3 días × 2 monedas: queda listo con progreso 1, posiciones cerradas, decisiones, curva y reporte', async () => {
    const row = await requestReplay()
    const outcome = await runReplaySession(deps(fixedScorer({ ETHUSDT: 0.9, BTCUSDT: -0.9 })), row.id)

    expect(outcome).toBe('listo')
    const session = await t.repos.sessions.get(row.id)
    expect(session).toMatchObject({ status: 'listo', progreso: 1 })
    expect(session?.mensaje).toMatch(/^Listo · \d+ trades? cerrados?$/)
    const { items: closed } = await t.repos.positions.listClosed(row.id)
    expect(closed.length).toBeGreaterThan(0)
    expect(closed.every((p) => p.id.startsWith(`replay-${row.id}-real-`))).toBe(true)
    const report = await t.repos.sessions.getReport(row.id)
    expect(report).toMatchObject({ version: 1, from: PERIOD.from, to: PERIOD.to, days: 3, capital: 1000, learning: { origin: 'zero', fromSessionId: null } })
    expect(report?.stats.real.trades).toBe(closed.length)
    expect(report?.stats.real.roi).toBeCloseTo(report!.stats.real.netPnl / 1000, 12)
    expect(report?.universeByDay['2026-10-28']).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT']))
    expect(report?.data.symbols).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(report?.caveats.survivorshipBias).toBe(true)
    const decisions = await t.repos.decisions.range(row.id, PERIOD.from, PERIOD.to)
    expect(decisions).toHaveLength(2 * 3 * 96)
    // El retorno a 4 h sale de las velas del replay: la decisión de `t` necesita la vela que
    // abre en `t + 15 × 15m`, que en las últimas 15 del período ya no está.
    expect(decisions.filter((d) => d.forwardReturn4h !== null)).toHaveLength(2 * (3 * 96 - 15))
    const curve = await t.repos.equity.series(row.id, PERIOD.from, PERIOD.to + 1)
    expect(curve.length).toBeGreaterThan(3 * 96)
    expect(await t.repos.learning.get(row.id)).not.toBeNull()
    // El universo de cada día queda en `universe_days`, como en vivo.
    expect((await t.repos.universeDays.latest(row.id))?.day).toBe('2026-10-30')
    const day = await t.repos.universeDays.forDay(row.id, '2026-10-28')
    expect(day?.symbols.map((e) => [e.symbol, e.rank])).toEqual([
      [expect.any(String), 1],
      [expect.any(String), 2],
    ])
    expect(day?.symbols.map((e) => e.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
  })

  it('pedido con el aprendizaje vigente sin una simulación en vivo: arranca de cero y la sesión dice lo mismo que el reporte', async () => {
    // Una activa que haya dejado otro archivo daría con qué continuar.
    await t.query(`update sessions set status = 'archived' where status = 'active'`)
    const row = await requestReplay(TWO_COINS, 'current')
    expect(row.learningOrigin).toBe('continued')

    expect(await runReplaySession(deps(fixedScorer()), row.id)).toBe('listo')
    expect((await t.repos.sessions.get(row.id))?.learningOrigin).toBe('zero')
    expect((await t.repos.sessions.getReport(row.id))?.learning).toEqual({ origin: 'zero', fromSessionId: null })
  })

  it('cancelado a mitad del período: se corta al terminar el día y no deja reporte', async () => {
    const row = await requestReplay()
    let cancelling: Promise<boolean> | null = null
    const base = fixedScorer({ ETHUSDT: 0.9 })
    const scorer: Scorer = (view, weights) => {
      if (cancelling === null && view.t >= PERIOD.from + DAY_MS) {
        cancelling = t.repos.sessions.updateProgress(row.id, { status: 'cancelado', progreso: 0.5, mensaje: 'Cancelado a pedido tuyo.' })
      }
      return base(view, weights)
    }
    const outcome = await runReplaySession(deps(scorer), row.id)

    expect(outcome).toBe('cancelado')
    expect(await cancelling).toBe(true)
    expect(await t.repos.sessions.get(row.id)).toMatchObject({ status: 'cancelado', mensaje: 'Cancelado a pedido tuyo.' })
    expect(await t.repos.sessions.getReport(row.id)).toBeNull()
    expect(await t.repos.equity.series(row.id, PERIOD.from, PERIOD.to + 1)).toEqual([])
    const lastDecision = (await t.repos.decisions.range(row.id, PERIOD.from, PERIOD.to)).at(-1)
    expect(lastDecision?.candleCloseTime).toBeLessThan(PERIOD.to - DAY_MS)
  })

  it('un error que no es de una moneda (Binance caído) lo deja fallido con el motivo', async () => {
    const row = await requestReplay()
    fake.failNext('/fapi/v1/exchangeInfo', { status: 503 })
    const outcome = await runReplaySession(deps(fixedScorer()), row.id)

    expect(outcome).toBe('fallido')
    const session = await t.repos.sessions.get(row.id)
    expect(session?.status).toBe('fallido')
    // Lo que ve Toti es una frase, no el texto técnico de Binance.
    expect(session?.mensaje).toBe('Falló: Binance no respondió bien mientras bajaba los datos. Probá de nuevo más tarde.')
  })
})
