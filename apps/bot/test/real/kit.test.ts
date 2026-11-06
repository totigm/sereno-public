import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import type { RealKit } from '../../src/real/kit'
import { openTestDb, type TestDb } from '../helpers/db'
import { drive, markTick, REAL_INFOS, REAL_T0 } from '../helpers/real'
import { createRealSession, openEth, realSessionRig, rebuildEngine, wideEth } from '../helpers/real-session'

const ETH = 'ETHUSDT'
const WAIT = { timeout: 3_000, interval: 10 }
const DAY = 86_400_000
const UNKNOWN_ERROR = { code: -1000, msg: 'Unknown error, please check your request or try again later.' }

// Un ajuste de riesgo que obliga a rehacer el motor (`LiveSession.pollSettings`).
const otherFee: Settings = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, takerFeeRate: 0.0004 } }

describe('rehacer el motor de la sesión real', { timeout: 20_000 }, () => {
  let fake: FakeBinance
  let t: TestDb
  let session: SessionRow
  let kit: RealKit | null = null

  beforeAll(async () => {
    fake = await FakeBinance.start()
    t = await openTestDb()
  })
  afterAll(async () => {
    await t.close()
    await fake.stop()
  })
  beforeEach(async () => {
    fake.reset()
    fake.trading.setMark(ETH, 2_000)
    session = await createRealSession(t)
  })
  afterEach(async () => {
    await kit?.stop()
    kit = null
    await t.query('delete from sessions where id = $1', [session.id])
  })

  const orders = () => fake.requests.filter((q) => q.method === 'POST' && q.path === '/fapi/v1/order')
  const botStops = () => fake.trading.algos.filter((a) => a.algoStatus === 'NEW' && a.orderType === 'STOP_MARKET' && a.clientAlgoId.startsWith('sereno-'))
  const realEvents = () => t.repos.realEvents.list(session.id, { from: 0, to: REAL_T0 + DAY })

  it('una apertura en duda sigue en duda con el motor nuevo: si Binance la llena, la cierra', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    fake.failNext('/fapi/v1/order', { method: 'POST', status: 500, body: UNKNOWN_ERROR })
    await drive(rig.clock, openEth(rig.lane))
    expect(rig.lane.snapshot().real.positions).toEqual([])
    const doubtful = orders().at(-1)!.query
    expect(fake.trading.orders).toEqual([])

    await rebuildEngine(rig, session.id, otherFee)
    // Binance la registra tarde: es del bot y nadie la protege.
    fake.trading.placeMarket({ symbol: ETH, side: 'BUY', qty: Number(doubtful.quantity), reduceOnly: false, clientOrderId: doubtful.newClientOrderId! })
    await vi.waitFor(() => expect(rig.kit.account.position(ETH)).not.toBeNull(), WAIT)

    await drive(rig.clock, rig.kit.exchange.resolveDoubtfulOpens())
    expect(fake.trading.position(ETH)).toBeNull()
    expect(orders().at(-1)!.query).toMatchObject({ side: 'SELL', quantity: doubtful.quantity, reduceOnly: 'true' })
    await vi.waitFor(async () => expect((await realEvents()).map((e) => e.kind)).toContain('unprotected'), WAIT)
  })

  it('un cierre a medias sigue contando con el motor nuevo: stop y cierre van por lo que le queda al bot', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS, (k) => wideEth(k, session.id))
    kit = rig.kit
    const { lane, clock } = rig
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_000, REAL_T0)))
    // Toti suma 0.2 a mano y el cierre del bot llena la mitad de lo suyo.
    fake.trading.manualPosition(ETH, 0.2)
    await vi.waitFor(() => expect(rig.kit.account.position(ETH)!.amount).toBeCloseTo(0.4, 9), WAIT)
    fake.trading.partialFillNext(0.5)
    await expect(lane.run((engine) => engine.closePosition(ETH, 'manual'))).rejects.toThrow(/cerré 0.1 de 0.2/)
    expect(botStops().map((a) => a.quantity)).toEqual(['0.100'])

    await rebuildEngine(rig, session.id, otherFee)
    // El motor nuevo repone la protección con el próximo precio: por lo que le queda al bot.
    await clock.advance(1_000)
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_000, clock.now())))
    expect(botStops().map((a) => a.quantity)).toEqual(['0.100'])

    const closed = await lane.run((engine) => engine.closePosition(ETH, 'manual'))
    expect(closed).toMatchObject({ symbol: ETH, qty: 0.2 })
    expect(orders().at(-1)!.query).toMatchObject({ side: 'SELL', quantity: '0.100', reduceOnly: 'true' })
    // Lo de Toti sigue.
    expect(fake.trading.position(ETH)!.amount).toBeCloseTo(0.2, 9)
  })

  it('si el motor nuevo no se puede retomar, sigue el anterior con lo que sabía de Binance', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS, (k) => wideEth(k, session.id))
    kit = rig.kit
    const { lane, clock } = rig
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_000, REAL_T0)))
    const before = rig.lane.engine
    const { [ETH]: _eth, ...withoutEth } = REAL_INFOS

    await expect(rebuildEngine(rig, session.id, otherFee, withoutEth)).rejects.toThrow(/símbolo desconocido: ETHUSDT/)
    expect(rig.lane.engine).toBe(before)

    await clock.advance(1_000)
    const closed = await lane.run((engine) => engine.closePosition(ETH, 'manual'))
    expect(closed).toMatchObject({ symbol: ETH, qty: 0.2 })
    expect(fake.trading.position(ETH)).toBeNull()
  })
})
