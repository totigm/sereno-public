import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { applyGlobalDelta, initialLearningState, rollWeek, weekStartOf } from '../../src/learning/state'
import { SIGNAL_IDS } from '../../src/types'
import { DAY, T0 } from './fixtures'

describe('initialLearningState', () => {
  it('arranca con todos los pesos en 1 y los parámetros por defecto', () => {
    const s = initialLearningState(T0)
    for (const id of SIGNAL_IDS) {
      expect(s.weightsGlobal[id]).toBe(1)
      expect(s.weeklyDelta[id]).toBe(0)
    }
    expect(s.weightsBySymbol).toEqual({})
    expect(s.confidenceBySymbol).toEqual({})
    expect(s.tradesBySymbol).toEqual({})
    expect(s.penalties).toEqual({})
    expect(s.params).toEqual({
      theta: DEFAULT_SETTINGS.entry.theta,
      k: DEFAULT_SETTINGS.exits.k,
      tpR: DEFAULT_SETTINGS.exits.tpR,
      trailingR: DEFAULT_SETTINGS.exits.trailingR,
      since: T0,
    })
    expect(s.frozen).toBe(false)
    expect(s.closedTrades).toBe(0)
    expect(s.weekStart).toBe(weekStartOf(T0))
    expect(s.version).toBe(1)
  })
})

describe('weekStartOf', () => {
  it('la semana empieza el lunes 00:00 UTC', () => {
    expect(weekStartOf(T0)).toBe(T0) // T0 ya es lunes
    expect(weekStartOf(T0 + 3 * DAY + 5_000)).toBe(T0) // jueves
    expect(weekStartOf(T0 + 6 * DAY + 23 * 3_600_000)).toBe(T0) // domingo a la noche
    expect(weekStartOf(T0 + 7 * DAY)).toBe(T0 + 7 * DAY)
    expect(weekStartOf(T0 - 1)).toBe(T0 - 7 * DAY)
  })
})

describe('rollWeek', () => {
  it('reinicia weeklyDelta al cambiar de semana y no toca nada dentro de la misma', () => {
    const base = initialLearningState(T0)
    const dirty = { ...base, weeklyDelta: { ...base.weeklyDelta, momentum: 0.12 } }
    expect(rollWeek(dirty, T0 + 6 * DAY)).toBe(dirty)
    const rolled = rollWeek(dirty, T0 + 7 * DAY)
    expect(rolled.weeklyDelta.momentum).toBe(0)
    expect(rolled.weekStart).toBe(T0 + 7 * DAY)
  })
})

describe('applyGlobalDelta', () => {
  it('acota el cambio al tope semanal y al rango [0.2, 2]', () => {
    const base = initialLearningState(T0)
    const a = applyGlobalDelta(base, 'momentum', 0.1, 0.15)
    expect(a.after).toBeCloseTo(1.1, 10)
    expect(a.state.weeklyDelta.momentum).toBeCloseTo(0.1, 10)
    const b = applyGlobalDelta(a.state, 'momentum', 0.1, 0.15)
    expect(b.after).toBeCloseTo(1.15, 10)
    expect(b.state.weeklyDelta.momentum).toBeCloseTo(0.15, 10)
    // En sentido contrario sí hay margen: el tope es ±0,15 acumulado.
    const c = applyGlobalDelta(b.state, 'momentum', -0.4, 0.15)
    expect(c.after).toBeCloseTo(0.85, 10)
    expect(c.state.weeklyDelta.momentum).toBeCloseTo(-0.15, 10)
  })

  it('el tope semanal cuenta el cambio aplicado, no el pedido, cuando el clamp lo recorta', () => {
    const base = initialLearningState(T0)
    const high = { ...base, weightsGlobal: { ...base.weightsGlobal, bands: 1.95 } }
    const a = applyGlobalDelta(high, 'bands', 0.1, 0.15)
    expect(a.after).toBe(2)
    expect(a.state.weeklyDelta.bands).toBeCloseTo(0.05, 10)
  })
})
