import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { silentLogger } from '../../src/logger'
import { processCommands, type CommandDeps } from '../../src/live/commands'
import type { RealKit } from '../../src/real/kit'
import { openTestDb, type TestDb } from '../helpers/db'
import { commandRow, enqueueCommand } from '../helpers/live'
import { REAL_T0 } from '../helpers/real'
import { createRealSession, openEth, realSessionRig, type RealSessionRig } from '../helpers/real-session'

const ETH = 'ETHUSDT'
const DAY = 86_400_000

describe('real_off', { timeout: 20_000 }, () => {
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
    vi.restoreAllMocks()
    await kit?.stop()
    kit = null
    await t.query('delete from sessions where id = $1', [session.id])
  })

  async function rig(): Promise<RealSessionRig> {
    const r = await realSessionRig(t, fake, session, DEFAULT_SETTINGS)
    kit = r.kit
    return r
  }

  // Sin marca reciente de nada: el interruptor no mira la edad del precio.
  function deps(r: RealSessionRig, real = true): CommandDeps {
    return {
      sessionId: session.id,
      instanceId: 'bot-de-prueba',
      repos: t.repos,
      now: r.clock.now,
      lane: r.lane,
      settings: () => DEFAULT_SETTINGS,
      markAge: () => null,
      hooks: {},
      logger: silentLogger,
      ...(real ? { real: r.controller.commands() } : {}),
    }
  }

  const botAlgos = () => fake.trading.algos.filter((a) => a.algoStatus === 'NEW' && a.clientAlgoId.startsWith('sereno-'))

  it('real_off cierra, cancela y apaga en un lote', async () => {
    const r = await rig()
    await openEth(r.lane)
    expect(botAlgos().length).toBeGreaterThan(0)
    const id = await enqueueCommand(t, session.id, 'real_off')

    await processCommands(deps(r))

    expect(await commandRow(t, session.id, id)).toMatchObject({ status: 'done', result: { ok: true, message: 'Cerré todo y apagué la operación con plata real.' } })
    expect(r.lane.snapshot().real.positions).toEqual([])
    expect(fake.trading.position(ETH)?.amount ?? 0).toBe(0)
    expect(botAlgos()).toEqual([])
    const row = await t.repos.sessions.get(session.id)
    expect({ status: row?.realStatus, reason: row?.realOffReason }).toEqual({ status: 'off', reason: 'user' })
    const events = await t.repos.realEvents.list(session.id, { from: 0, to: REAL_T0 + DAY })
    expect(events.map((e) => e.kind)).toEqual(['off'])
    // Deja de abrir en el acto, sin esperar a leer la base.
    expect(r.controller.gate()).toEqual({ mode: 'reduce_only', missing: ['prenderla en Ajustes'] })
  })

  it('si no puede cancelar los algos del bot, lo dice en los errores de la sesión', async () => {
    const r = await rig()
    await openEth(r.lane)
    vi.spyOn(r.kit.exchange, 'cancelAllBot').mockRejectedValueOnce(new Error('Binance no contesta'))
    const id = await enqueueCommand(t, session.id, 'real_off')

    await processCommands(deps(r))

    expect(await commandRow(t, session.id, id)).toMatchObject({
      status: 'done',
      result: { ok: true, message: 'Cerré todo y apagué la operación con plata real. No pude cancelar los stops del bot que quedaron: los cancelo en la próxima revisión.' },
    })
    expect(r.errors.list().map((e) => e.message)).toEqual(['No pude cancelar los stops del bot al apagar: Binance no contesta'])
  })

  it('real_off no vence', async () => {
    const r = await rig()
    const id = await enqueueCommand(t, session.id, 'real_off')
    await t.query(`update bot_commands set created_at = now() - interval '2 hours' where id = $1`, [id])

    await processCommands(deps(r))

    expect(await commandRow(t, session.id, id)).toMatchObject({ status: 'done', result: { ok: true } })
    expect((await t.repos.sessions.get(session.id))?.realStatus).toBe('off')
  })

  it('en una simulación no hace nada', async () => {
    const r = await rig()
    const id = await enqueueCommand(t, session.id, 'real_off')

    await processCommands(deps(r, false))

    expect(await commandRow(t, session.id, id)).toMatchObject({ result: { ok: false, message: 'Esta simulación no opera con plata real.' } })
    expect((await t.repos.sessions.get(session.id))?.realStatus).toBe('on')
  })
})
