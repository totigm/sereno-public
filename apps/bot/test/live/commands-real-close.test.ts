import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { silentLogger } from '../../src/logger'
import { processCommands, type CommandDeps } from '../../src/live/commands'
import type { RealKit } from '../../src/real/kit'
import { openTestDb, type TestDb } from '../helpers/db'
import { commandRow, enqueueCommand } from '../helpers/live'
import { createRealSession, openEth, realSessionRig, type RealSessionRig } from '../helpers/real-session'

// Los cierres que Toti pide en la sesión real cuando Binance no cierra todo: un cierre pedido no
// se reintenta solo, así que el comando dice qué quedó y no promete otro intento.

const ETH = 'ETHUSDT'

describe('cierres pedidos en la sesión real', { timeout: 20_000 }, () => {
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

  async function rig(): Promise<RealSessionRig> {
    const r = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = r.kit
    await openEth(r.lane)
    return r
  }

  // Con la marca recién llegada: el comando cierra.
  function deps(r: RealSessionRig): CommandDeps {
    return {
      sessionId: session.id,
      instanceId: 'bot-de-prueba',
      repos: t.repos,
      now: r.clock.now,
      lane: r.lane,
      settings: () => DEFAULT_SETTINGS,
      markAge: () => 0,
      hooks: {},
      logger: silentLogger,
      real: r.controller.commands(),
    }
  }

  const botStops = () => fake.trading.algos.filter((a) => a.algoStatus === 'NEW' && a.orderType === 'STOP_MARKET')

  it('un close_position que llena a medias dice qué quedó abierto y pedirlo de nuevo cierra el resto', async () => {
    const r = await rig()
    expect(fake.trading.position(ETH)!.amount).toBe(0.12)
    fake.trading.partialFillNext(0.5)
    const first = await enqueueCommand(t, session.id, 'close_position', { symbol: ETH })

    await processCommands(deps(r))

    expect(fake.trading.position(ETH)!.amount).toBe(0.06)
    expect(await commandRow(t, session.id, first)).toMatchObject({
      status: 'failed',
      result: { ok: false, message: 'No pude cerrar ETH: cerré 0.06 de 0.12 en ETH; lo demás sigue abierto con su stop. Si querés cerrar lo que quedó, pedilo de nuevo.' },
    })
    expect(botStops().map((a) => a.quantity)).toEqual(['0.060'])

    const second = await enqueueCommand(t, session.id, 'close_position', { symbol: ETH })
    await processCommands(deps(r))

    expect(await commandRow(t, session.id, second)).toMatchObject({ status: 'done', result: { ok: true, message: 'Cerré ETH.' } })
    expect(fake.trading.position(ETH)).toBeNull()
    expect(r.lane.snapshot().real.positions).toEqual([])
  })

  it('un close_all que no puede cerrar una no promete reintentarla', async () => {
    const r = await rig()
    fake.trading.rejectNext('/fapi/v1/order', -4131)
    const id = await enqueueCommand(t, session.id, 'close_all')

    await processCommands(deps(r))

    expect(await commandRow(t, session.id, id)).toMatchObject({
      status: 'failed',
      result: { ok: false, message: 'Cerré 0 posiciones. 1 no se pudo cerrar; si querés cerrarla, pedilo de nuevo.' },
    })
    expect(fake.trading.position(ETH)).not.toBeNull()
    expect(botStops()).toHaveLength(1)
  })
})
