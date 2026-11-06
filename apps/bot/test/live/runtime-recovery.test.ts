import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { fundingRateRows } from '../../src/binance/fake/fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import type { LiveRest } from '../../src/live/live-types'
import { openTestDb, type TestDb } from '../helpers/db'
import {
  backdate,
  commandRow,
  createActiveSession,
  dropSession,
  enqueueCommand,
  equityAt,
  fixedScorer,
  M15,
  pauseAuto,
  previousHeartbeat,
  seedOpen,
  setPause,
  startHarness,
  type Harness,
} from '../helpers/live'

// Retomar después de un hueco: reinicio, reconexión, sesión archivada, pausa levantada
// con el bot apagado y funding.
const T = Date.UTC(2026, 9, 31, 12, 15, 0)
const START = T - 20_000
const WAIT = { timeout: 5_000, interval: 25 }
const HOUR = 3_600_000
const DAY = 24 * HOUR

let fake: FakeBinance
let t: TestDb
let sessions: SessionRow[] = []
let h: Harness | null = null

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  fake.reset()
  sessions = [await createActiveSession(t)]
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  for (const s of sessions) await dropSession(t, s.id)
})

function first(): SessionRow {
  return sessions[0]!
}

async function closedReasons(sessionId: string) {
  const { items } = await t.repos.positions.listClosed(sessionId)
  return items.map((c) => c.closeReason)
}

// Las velas por REST esperan a `held`: el calentamiento queda a mitad de camino.
function holdKlines(held: Promise<void>) {
  return (rest: LiveRest): LiveRest =>
    new Proxy(rest, {
      get: (target, key) => {
        if (key === 'klines') {
          return async (...args: Parameters<LiveRest['klines']>) => {
            await held
            return target.klines(...args)
          }
        }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
}

async function start(scorer = fixedScorer(), at = START): Promise<Harness> {
  h = await startHarness({ t, fake, start: at, scorer })
  await h.runtime.ready()
  h.openSocket()
  return h
}

describe('runtime en vivo: retomar', { timeout: 30_000 }, () => {
  it('al arrancar, una abierta cuyo stop quedó atrás cierra como stop no ejecutado', async () => {
    // La marca del Binance falso para ETH ronda 2.500,38.
    await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_600, stopPrice: 2_550, qty: 0.1, openedAt: START - 3_600_000 })
    await start()
    expect(await closedReasons(first().id)).toEqual(['stop_missed_offline'])
  })

  it('al reconectar recupera las velas perdidas por REST y reevalúa las abiertas', async () => {
    await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_450, qty: 0.1, openedAt: START - 3_600_000 })
    const { clock, sockets, pushKline, pushMark } = await start()
    // La última vela que vio el stream antes del corte es la de las 11:45 (la del calentamiento).
    pushKline('ETHUSDT', T - 2 * M15)
    sockets.at(-1)!.drop()
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT)
    h!.openSocket()
    // Vuelve a las 12:30 con la vela de las 12:15: la de las 12:00 se perdió en el corte.
    await clock.advanceTo(T + M15)
    pushKline('ETHUSDT', T)
    await vi.waitFor(async () => {
      const candles = await t.repos.candles.range('ETHUSDT', '15m', 'last', T - M15, T - M15 + 1)
      expect(candles.map((c) => c.openTime)).toEqual([T - M15])
    }, WAIT)
    pushMark('ETHUSDT', 2_440)
    await vi.waitFor(async () => expect(await closedReasons(first().id)).toEqual(['stop_missed_offline']), WAIT)
  })

  it('el funding se cobra cuando avanza el próximo instante, con payload { amount } > 0 = pagado', async () => {
    // Arranca un poco antes de la liquidación de las 16:00 (avanzar horas de reloj falso es lento).
    const funding = Date.UTC(2026, 9, 31, 16, 0, 0)
    const eth = await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_400, qty: 0.1, openedAt: funding - 3_600_000 })
    const { clock, pushMark } = await start(fixedScorer(), funding - 30_000)
    pushMark('ETHUSDT', 2_500)
    await clock.advanceTo(funding + 1_000)
    pushMark('ETHUSDT', 2_500)
    await vi.waitFor(async () => {
      const funding = (await t.repos.positions.listEvents(eth.id)).filter((e) => e.kind === 'funding')
      expect(funding.map((e) => e.payload)).toEqual([{ amount: expect.closeTo(0.1 * 2_500 * 0.0001, 9) }])
    }, WAIT)
  })

  it('al arrancar cobra el funding que venció con el bot apagado, y reiniciar no lo cobra de nuevo', async () => {
    const funding = Date.UTC(2026, 9, 31, 16, 0, 0)
    const eth = await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_000, qty: 0.1, openedAt: funding - 3 * HOUR })
    const charged = async () => (await t.repos.positions.listEvents(eth.id)).filter((e) => e.kind === 'funding')
    const [row] = fundingRateRows({ symbol: 'ETHUSDT', startTime: funding, endTime: funding, now: funding })
    const paid = 0.1 * Number(row!.markPrice) * Number(row!.fundingRate)

    await start(fixedScorer(), funding + 30 * 60_000)
    expect((await charged()).map((e) => ({ at: e.at.getTime(), payload: e.payload }))).toEqual([{ at: funding, payload: { amount: expect.closeTo(paid, 9) } }])
    expect((await t.repos.positions.listOpen(first().id))[0]?.fundingPaid).toBeCloseTo(paid, 9)

    await h!.runtime.stop()
    h = null
    await start(fixedScorer(), funding + 40 * 60_000)
    expect(await charged()).toHaveLength(1)
  })

  it('un funding vencido con la marca vacía no se da por cobrado: lo cobra con la marca del próximo tick', async () => {
    const funding = Date.UTC(2026, 9, 31, 16, 0, 0)
    const eth = await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_000, qty: 0.1, openedAt: funding - 3 * HOUR })
    const charged = async () => (await t.repos.positions.listEvents(eth.id)).filter((e) => e.kind === 'funding')
    const [row] = fundingRateRows({ symbol: 'ETHUSDT', startTime: funding, endTime: funding, now: funding })
    // Binance devuelve `markPrice: ""` en algunas liquidaciones: el cliente lo lee como 0.
    const emptyMark = (rest: LiveRest): LiveRest =>
      new Proxy(rest, {
        get: (target, key) => {
          if (key === 'fundingRate') {
            return async (...args: Parameters<LiveRest['fundingRate']>) => (await target.fundingRate(...args)).map((f) => ({ ...f, markPrice: 0 }))
          }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    h = await startHarness({ t, fake, start: funding + 30 * 60_000, scorer: fixedScorer(), wrapRest: emptyMark })
    await h.runtime.ready()
    h.openSocket()
    expect(await charged()).toEqual([])

    h.pushMark('ETHUSDT', 2_500)
    await vi.waitFor(async () => {
      expect((await charged()).map((e) => ({ at: e.at.getTime(), payload: e.payload }))).toEqual([
        { at: funding, payload: { amount: expect.closeTo(0.1 * 2_500 * Number(row!.fundingRate), 9) } },
      ])
    }, WAIT)
    // Otro tick no lo vuelve a cobrar.
    h.pushMark('ETHUSDT', 2_510)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await charged()).toHaveLength(1)
  })

  it('si archivan la sesión, deja de escribirle y toma la nueva activa sin volver a calentar', async () => {
    const eth = await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_450, qty: 0.1, openedAt: START - 3_600_000 })
    const { runtime, pushMark } = await start()
    expect((await t.repos.sessions.archive(first().id, { closeOpen: false })).archived).toBe(true)
    const next = await createActiveSession(t)
    sessions.push(next)
    const klines = fake.requests.filter((r) => r.path.endsWith('klines')).length

    // El cierre por stop choca con la sesión archivada: no se escribe y el runtime pasa a la nueva.
    pushMark('ETHUSDT', 2_440)
    await vi.waitFor(() => expect(runtime.status().sessionId).toBe(next.id), WAIT)
    await runtime.ready()
    expect(runtime.status()).toEqual({ phase: 'live', sessionId: next.id })
    expect((await t.repos.positions.listOpen(first().id)).map((p) => p.id)).toEqual([eth.id])
    expect(await closedReasons(first().id)).toEqual([])
    expect(fake.requests.filter((r) => r.path.endsWith('klines')).length).toBe(klines)
  })

  it('mientras calienta, un stop de una abierta que se cruza cierra en ese momento', async () => {
    await seedOpen(t, first().id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_450, qty: 0.1, openedAt: START - 3_600_000 })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h = await startHarness({ t, fake, start: START, wrapRest: holdKlines(held) })
    await vi.waitFor(() => expect(h!.runtime.status().phase).toBe('warming'), WAIT)
    h.openSocket()
    h.pushMark('ETHUSDT', 2_440)
    await vi.waitFor(async () => expect(await closedReasons(first().id)).toEqual(['stop']), WAIT)
    expect(h.runtime.status().phase).toBe('warming')
    release()
    await h.runtime.ready()
  })

  it('si archivan la sesión mientras calienta, toma la nueva enseguida y sin errores', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h = await startHarness({ t, fake, start: START, wrapRest: holdKlines(held) })
    const { clock, runtime } = h
    await vi.waitFor(() => expect(runtime.status()).toEqual({ phase: 'warming', sessionId: first().id }), WAIT)
    expect((await t.repos.sessions.archive(first().id, { closeOpen: false })).archived).toBe(true)
    const next = await createActiveSession(t)
    sessions.push(next)
    // El latido ve la sesión archivada y la retira; el calentamiento termina después.
    await clock.advance(10_000)
    release()
    await vi.waitFor(() => expect(runtime.status()).toEqual({ phase: 'live', sessionId: next.id }), WAIT)
    expect((await t.repos.bot.get(next.id))?.recentErrors).toEqual([])
  })

  it('una pausa por drawdown que Toti levantó con el bot apagado no frena las entradas', async () => {
    const id = first().id
    // El proceso anterior se pausó por drawdown desde un pico de 1.200 y su último latido lo dice...
    const paused = await pauseAuto(t, id, START - 2 * HOUR, 'Me pausé solo: el capital cayó un 16,7% desde el pico.')
    await previousHeartbeat(t, id, { drawdownPause: true }, paused)
    // ...y Toti reanudó mientras el bot estaba apagado.
    const resumed = await setPause(t, id, DEFAULT_SETTINGS.pause)
    await backdate(t, id, START - DAY, { 1: START - DAY, [paused]: START - 2 * HOUR, [resumed]: START - HOUR })
    // La curva no muestra la caída: el pico de 1.200 sólo lo borra la regla del motor al
    // retomar (si quedara, con el equity en 1.000 el drawdown volvería a pausar enseguida).
    await t.repos.equity.insert(id, equityAt(START - 3 * HOUR, 1_200))

    const { clock, pushKline } = await start(fixedScorer({ ETHUSDT: 0.8 }))
    await clock.advanceTo(T)
    pushKline('BTCUSDT', T - M15)
    pushKline('ETHUSDT', T - M15)
    await vi.waitFor(async () => {
      const rows = await t.repos.decisions.range(id, T, T + 1)
      expect(Object.fromEntries(rows.map((r) => [r.symbol, r.action]))).toEqual({ BTCUSDT: 'wait', ETHUSDT: 'enter_long' })
    }, WAIT)
    expect((await t.repos.settings.get(id))?.version).toBe(resumed)
  })

  it('al reiniciar con la pausa por drawdown puesta la retoma: release_protected no la levanta y una sola reanudación alcanza', async () => {
    const id = first().id
    // Blindado, pausado por drawdown (pico 1.200, equity 1.000) y con el último latido diciéndolo.
    await t.repos.sessions.updateShield(id, { protegido: 1_000, baseBlindaje: 1_000 })
    const paused = await pauseAuto(t, id, START - 2 * HOUR, 'Me pausé solo: el capital cayó un 16,7% desde el pico.')
    await previousHeartbeat(t, id, { drawdownPause: true }, paused)
    await backdate(t, id, START - DAY, { 1: START - DAY, [paused]: START - 2 * HOUR })
    await t.repos.equity.insert(id, [equityAt(START - 3 * HOUR, 1_200), equityAt(START - 2 * HOUR, 1_000)])

    const { clock, pushKline } = await start(fixedScorer({ ETHUSDT: 0.8 }))
    expect(await t.repos.bot.get(id)).toMatchObject({ phase: 'paused', flags: { drawdownPause: true } })

    // Volver a usar el capital blindado no levanta una pausa por drawdown.
    const release = await enqueueCommand(t, id, 'release_protected')
    await clock.advance(3_000)
    await vi.waitFor(async () => expect((await commandRow(t, id, release))?.result).toMatchObject({ ok: true }), WAIT)
    expect(await t.repos.settings.get(id)).toMatchObject({ version: paused, config: { pause: { paused: true, by: 'auto' } } })
    expect((await t.repos.sessions.get(id))?.protegido).toBe(0)

    // Toti reanuda una vez: el pico se vuelve a medir y el ciclo siguiente entra.
    const resumed = await setPause(t, id, DEFAULT_SETTINGS.pause)
    await clock.advance(3_000)
    await clock.advanceTo(T)
    await vi.waitFor(async () => expect(await t.repos.bot.get(id)).toMatchObject({ phase: 'live', settingsVersionApplied: resumed, flags: { drawdownPause: false } }), WAIT)
    pushKline('BTCUSDT', T - M15)
    pushKline('ETHUSDT', T - M15)
    await vi.waitFor(async () => {
      const rows = await t.repos.decisions.range(id, T, T + 1)
      expect(Object.fromEntries(rows.map((r) => [r.symbol, r.action]))).toEqual({ BTCUSDT: 'wait', ETHUSDT: 'enter_long' })
    }, WAIT)
    expect((await t.repos.settings.get(id))?.version).toBe(resumed)
  })
})
