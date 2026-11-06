import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { loadConfig } from '../../src/config'
import { gateConfig } from '../../src/real/controller'
import type { RealKit } from '../../src/real/kit'
import { openTestDb, type TestDb } from '../helpers/db'
import { drive, markTick, REAL_T0 } from '../helpers/real'
import { createRealSession, openEth, realSessionRig, wideEth } from '../helpers/real-session'

const ETH = 'ETHUSDT'
const WAIT = { timeout: 3_000, interval: 10 }
const DAY = 86_400_000

describe('RealController', { timeout: 20_000 }, () => {
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
    session = await createRealSession(t, 0.1)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await kit?.stop()
    kit = null
    await t.query('delete from sessions where id = $1', [session.id])
  })

  const botAlgos = () => fake.trading.algos.filter((a) => a.algoStatus === 'NEW' && a.clientAlgoId.startsWith('sereno-'))
  const realEvents = () => t.repos.realEvents.list(session.id, { from: 0, to: REAL_T0 + DAY })

  it('del proceso recibe sólo si está prendida y el entorno, nunca las claves', () => {
    const { real } = loadConfig({ DATABASE_URL_UNPOOLED: 'postgresql://x/y', SERENO_REAL_TRADING: 'on', BINANCE_ENV: 'testnet', BINANCE_TRADE_API_KEY: 'clave', BINANCE_TRADE_API_SECRET: 'secreto' })
    expect(gateConfig(real)).toStrictEqual({ enabled: true, env: 'testnet' })
  })

  it('al tocar el tope queda apagada por el tope de pérdida', async () => {
    // Piso en 900: con el stop lejos, el tope llega antes que el stop.
    const settings: Settings = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.1 } }
    const rig = await realSessionRig(t, fake, session, settings, (k) => wideEth(k, session.id))
    kit = rig.kit
    const { clock, lane, controller } = rig
    // El primer precio repone stop y take profit en Binance.
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_000, REAL_T0)))
    expect(botAlgos().map((a) => a.orderType).sort()).toEqual(['STOP_MARKET', 'TAKE_PROFIT_MARKET'])

    await clock.advance(60_000)
    fake.trading.setMark(ETH, 1_450)
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 1_450, clock.now())))

    expect(lane.snapshot().real.positions).toEqual([])
    expect((await t.repos.sessions.get(session.id))?.realStatus).toBe('loss_floor')
    expect(controller.gate()).toEqual({ mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] })
    expect(botAlgos()).toEqual([])
    expect((await realEvents()).filter((e) => e.kind === 'loss_floor')).toHaveLength(1)
  })

  const stored = async () => {
    const row = await t.repos.sessions.get(session.id)
    return { status: row?.realStatus, reason: row?.realOffReason }
  }

  const OFF = { at: REAL_T0, kind: 'off' as const, symbol: null, phrase: 'Apagaste la operación con plata real: cerré lo que tenía abierto.' }
  const journal = async () => (await realEvents()).map((e) => [e.kind, e.at])

  it('un apagado que la base no guardó no se deshace con la próxima lectura: lo vuelve a guardar con su entrada del diario', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    const { controller } = rig
    expect(controller.openings()).toEqual({ allowed: true })
    // `real_off` deja de abrir en el acto; su lote no llega a la base.
    controller.switchOff(OFF)
    const save = vi.spyOn(t.repos.sessions, 'setRealStatus').mockRejectedValueOnce(new Error('la base no contesta'))

    await controller.poll()
    expect(controller.openings().allowed).toBe(false)
    expect(await stored()).toEqual({ status: 'on', reason: null })

    await controller.poll()
    expect(save).toHaveBeenCalledTimes(2)
    expect(await stored()).toEqual({ status: 'off', reason: 'user' })
    expect(controller.openings().allowed).toBe(false)
    expect(await journal()).toEqual([['off', REAL_T0]])
    await controller.poll()
    expect(await journal()).toEqual([['off', REAL_T0]])

    // Guardado: lo que Toti haga después en la base vuelve a mandar.
    await t.repos.sessions.setRealStatus(session.id, 'on', null)
    await controller.poll()
    expect(controller.openings()).toEqual({ allowed: true })
  })

  it('si el lote del apagado se escribe mientras lo vuelve a guardar, la entrada del diario no se duplica', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    const { controller } = rig
    controller.switchOff(OFF)
    // La lectura todavía ve `on`; el lote reintentado entra justo después.
    const before = (await t.repos.sessions.get(session.id))!
    vi.spyOn(t.repos.sessions, 'get').mockResolvedValueOnce(before)
    await t.repos.sessions.setRealStatus(session.id, 'off', 'user')
    await t.repos.realEvents.append(session.id, [OFF])

    await controller.poll()

    expect(await stored()).toEqual({ status: 'off', reason: 'user' })
    expect(await journal()).toEqual([['off', REAL_T0]])
  })

  it('un apagado sin guardar no pisa a Toti si la prendió después de que el lote entró', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    const { controller } = rig
    controller.switchOff(OFF)
    vi.spyOn(t.repos.sessions, 'setRealStatus').mockRejectedValueOnce(new Error('la base no contesta'))
    await controller.poll()
    expect(await stored()).toEqual({ status: 'on', reason: null })

    // El lote reintentado la apaga y Toti la vuelve a prender antes de la próxima lectura.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await t.repos.sessions.setRealStatus(session.id, 'off', 'user')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await t.repos.sessions.setRealStatus(session.id, 'on', null)

    await controller.poll()
    expect(await stored()).toEqual({ status: 'on', reason: null })
    expect(controller.openings()).toEqual({ allowed: true })
  })

  it('el tope de pérdida que la base no guardó no vuelve a prender la operación con la próxima lectura', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.1 } }
    const rig = await realSessionRig(t, fake, session, settings, (k) => wideEth(k, session.id))
    kit = rig.kit
    const { clock, lane, controller } = rig
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_000, REAL_T0)))
    await clock.advance(60_000)
    fake.trading.setMark(ETH, 1_450)
    vi.spyOn(t.repos.sessions, 'setRealStatus').mockRejectedValueOnce(new Error('la base no contesta'))
    await expect(lane.run((engine) => engine.onMarkTick(markTick(ETH, 1_450, clock.now())))).rejects.toThrow('la base no contesta')
    expect(await stored()).toEqual({ status: 'on', reason: null })

    await controller.poll()

    const floor = { mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] }
    expect(controller.gate()).toEqual(floor)
    expect((await t.repos.sessions.get(session.id))?.realStatus).toBe('loss_floor')
    expect((await realEvents()).filter((e) => e.kind === 'loss_floor')).toHaveLength(1)
    await controller.poll()
    expect(controller.gate()).toEqual(floor)
  })

  it('el tope de pérdida que la base no guardó se guarda aunque la base ya la tuviera apagada', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.1 } }
    const rig = await realSessionRig(t, fake, session, settings, (k) => wideEth(k, session.id))
    kit = rig.kit
    const { clock, lane, controller } = rig
    await lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_000, REAL_T0)))
    await t.repos.sessions.setRealStatus(session.id, 'off', 'user')
    await controller.poll()
    await clock.advance(60_000)
    fake.trading.setMark(ETH, 1_450)
    vi.spyOn(t.repos.sessions, 'setRealStatus').mockRejectedValueOnce(new Error('la base no contesta'))
    await expect(lane.run((engine) => engine.onMarkTick(markTick(ETH, 1_450, clock.now())))).rejects.toThrow('la base no contesta')
    expect(await stored()).toEqual({ status: 'off', reason: 'user' })

    await controller.poll()

    const floor = { mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] }
    expect(controller.gate()).toEqual(floor)
    expect(await stored()).toEqual({ status: 'loss_floor', reason: null })
    expect((await realEvents()).filter((e) => e.kind === 'loss_floor')).toHaveLength(1)
    await controller.poll()
    expect(controller.gate()).toEqual(floor)
  })

  it('un apagado que se reintenta no pisa a Toti si la prendió entre la lectura y la escritura', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    const { controller } = rig
    controller.switchOff(OFF)
    // La lectura ve la base como estaba al apagar; antes de que el lote reintentado se
    // escriba, el lote original entra y Toti la vuelve a prender.
    const before = (await t.repos.sessions.get(session.id))!
    await t.repos.sessions.setRealStatus(session.id, 'off', 'user')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await t.repos.sessions.setRealStatus(session.id, 'on', null)
    vi.spyOn(t.repos.sessions, 'get').mockResolvedValueOnce(before)

    await controller.poll()
    expect(await stored()).toEqual({ status: 'on', reason: null })
    expect(await journal()).toEqual([['off', REAL_T0]])

    await controller.poll()
    expect(controller.openings()).toEqual({ allowed: true })
  })

  it('lo fatal queda apagado aunque su lote no se guarde, y vuelve a apagar si Toti la prende', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    const { controller } = rig
    const fatal = { kind: 'fatal' as const, symbol: null, phrase: 'Binance rechazó la clave de la API.' }
    vi.spyOn(t.repos.sessions, 'setRealStatus').mockRejectedValueOnce(new Error('la base no contesta'))
    controller.note(fatal)
    await vi.waitFor(() => expect(rig.errors.list().map((e) => e.message)).toContainEqual(expect.stringMatching(/^No pude cerrar todo después del error fatal/)), WAIT)

    await controller.poll()
    expect(await stored()).toEqual({ status: 'off', reason: 'fatal' })
    expect(controller.openings().allowed).toBe(false)

    await t.repos.sessions.setRealStatus(session.id, 'on', null)
    await controller.poll()
    expect(controller.openings()).toEqual({ allowed: true })
    controller.note(fatal)
    expect(controller.openings().allowed).toBe(false)
    await vi.waitFor(async () => expect(await stored()).toEqual({ status: 'off', reason: 'fatal' }), WAIT)
  })

  it('un -2015 la apaga cerrando lo que puede', async () => {
    const rig = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = rig.kit
    const { clock, lane, controller } = rig
    await openEth(lane)
    expect(lane.snapshot().real.positions.map((p) => p.position.symbol)).toEqual([ETH])
    fake.rejectKey()

    // Cualquier pedido de ahora en más vuelve con la clave rechazada. La operación misma falla
    // (el cierre no sale); lo que importa es lo que deja el controlador. La marca cruza el take
    // profit: antes de cerrar se espera su disparo y se lo busca por REST.
    await clock.advance(60_000)
    await drive(clock, lane.run((engine) => engine.onMarkTick(markTick(ETH, 2_200, clock.now())))).catch(() => undefined)

    // El cierre de todo después del fatal también espera ese disparo.
    await vi.waitFor(async () => {
      await clock.advance(250)
      const row = await t.repos.sessions.get(session.id)
      expect({ status: row?.realStatus, reason: row?.realOffReason }).toEqual({ status: 'off', reason: 'fatal' })
    }, WAIT)
    expect(controller.gate().mode).toBe('reduce_only')
    await vi.waitFor(async () => expect((await realEvents()).map((e) => e.kind)).toContain('fatal'), WAIT)
    // No pudo cerrar nada (Binance rechaza todo): la posición sigue y la cuida su stop allá.
    expect(lane.snapshot().real.positions.map((p) => p.position.symbol)).toEqual([ETH])
  })
})
