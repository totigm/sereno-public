import { describe, expect, it } from 'vitest'
import { exitRulesFor } from '../../src/engine/exits'
import { initialLearningState } from '../../src/learning/state'
import { playCandle } from '../../src/replay/candle-player'
import { resolveCandle } from '../../src/replay/intra-candle'
import { createLane } from '../../src/replay/lane'
import type { EngineEvent } from '../../src/types'
import { infoOf, settingsWith, stateWith, T } from '../engine/fixtures'
import { INTRA_CANDLE_CASES, type IntraCandleCase } from './cases'

// El replay no tiene su propia lógica de salidas: lleva al motor por el camino canónico
// de la vela con ticks sintéticos. Acá se corren por el motor los mismos casos que
// `resolveCandle` y tienen que dar lo mismo (sin costos, el fill es el precio de referencia).

async function throughEngine(c: IntraCandleCase) {
  const settings = settingsWith()
  const events: EngineEvent[] = []
  const lane = createLane({
    infos: { SOLUSDT: infoOf('SOLUSDT') },
    settings,
    learning: initialLearningState(T),
    capital: 1_000,
    start: T,
    idPrefix: 'replay-test',
    shadow: false,
    sink: (e) => events.push(e),
    onFailure: (f) => {
      throw f.error
    },
  })
  await lane.engine.restore(stateWith(c.position))
  for (const { position } of lane.engine.snapshot().real.positions) lane.levels.track(position)
  await playCandle(lane, T, new Map([['SOLUSDT', { last: c.last, mark: c.mark ?? c.last }]]), { fromOpen: true })

  const closed = events.flatMap((e) => (e.type === 'position_closed' ? [e.position] : []))
  const [done] = closed
  if (done) {
    return { closedBy: done.closeReason, exitPrice: done.exitPrice, newStop: done.stopPrice, newBest: done.bestPrice, trailingActive: done.trailingActive }
  }
  const open = lane.engine.snapshot().real.positions[0]?.position
  if (!open) throw new Error('la posición desapareció sin cerrarse')
  return { closedBy: null, exitPrice: null, newStop: open.stopPrice, newBest: open.bestPrice, trailingActive: open.trailingActive }
}

describe('el motor por el camino canónico coincide con resolveCandle', () => {
  for (const c of INTRA_CANDLE_CASES) {
    it(c.name, async () => {
      const pure = resolveCandle(c.position, c.last, c.mark ?? c.last, exitRulesFor(c.position, settingsWith(), 0.01))
      const engine = await throughEngine(c)
      const { exitPrice, ...rest } = pure
      expect(engine).toMatchObject(rest)
      if (exitPrice === null) expect(engine.exitPrice).toBeNull()
      else expect(engine.exitPrice).toBeCloseTo(exitPrice, 9)
    })
  }
})
