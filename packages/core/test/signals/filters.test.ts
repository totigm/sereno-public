import { describe, expect, it } from 'vitest'
import { entryFilters, type EntryContext } from '../../src/signals/filters'
import { T, compositeOf, fullView, viewOf } from './fixtures'

const view = fullView()
const clear: EntryContext = { hasPosition: false, inCooldown: false, inPenalty: false, degraded: false, direction: 'both' }

describe('entryFilters', () => {
  it('null cuando nada bloquea', () => {
    expect(entryFilters(view, compositeOf(), clear)).toBeNull()
    expect(entryFilters(view, compositeOf({ S: -0.5 }), clear)).toBeNull()
  })

  it('higher_trend_against cuando 1h y 4h están en contra; uno solo no bloquea', () => {
    expect(entryFilters(view, compositeOf({ higherTrendAgainst: 2 }), clear)).toBe('higher_trend_against')
    expect(entryFilters(view, compositeOf({ higherTrendAgainst: 1 }), clear)).toBeNull()
  })

  it('low_volume con volumen relativo 0,5; 0,8 pasa', () => {
    expect(entryFilters(view, compositeOf({ relVolume: 0.5 }), clear)).toBe('low_volume')
    expect(entryFilters(view, compositeOf({ relVolume: 0.8 }), clear)).toBeNull()
    expect(entryFilters(view, compositeOf({ relVolume: 0.8 }), { ...clear, minRelVolume: 0.9 })).toBe('low_volume')
  })

  it('has_position, cooldown, penalty y degraded', () => {
    expect(entryFilters(view, compositeOf(), { ...clear, hasPosition: true })).toBe('has_position')
    expect(entryFilters(view, compositeOf(), { ...clear, inCooldown: true })).toBe('cooldown')
    expect(entryFilters(view, compositeOf(), { ...clear, inPenalty: true })).toBe('penalty')
    expect(entryFilters(view, compositeOf(), { ...clear, degraded: true })).toBe('degraded')
  })

  it('direction_not_allowed con direction long y S < 0 (y simétrico)', () => {
    expect(entryFilters(view, compositeOf({ S: -0.4 }), { ...clear, direction: 'long' })).toBe('direction_not_allowed')
    expect(entryFilters(view, compositeOf({ S: 0.4 }), { ...clear, direction: 'long' })).toBeNull()
    expect(entryFilters(view, compositeOf({ S: 0.4 }), { ...clear, direction: 'short' })).toBe('direction_not_allowed')
    expect(entryFilters(view, compositeOf({ S: -0.4 }), { ...clear, direction: 'short' })).toBeNull()
    // Sin lado (S = 0) no hay dirección que prohibir.
    expect(entryFilters(view, compositeOf({ S: 0 }), { ...clear, direction: 'long' })).toBeNull()
  })

  it('no_candle sin vela de 15m en la vista', () => {
    expect(entryFilters(viewOf(), compositeOf(), clear)).toBe('no_candle')
  })

  it('no_candle si la última vela de 15m no es la que cerró en t (llegó tarde o falta)', () => {
    // La vista es de las 10:15; sin la vela 10:00–10:15 la última es la de las 09:45.
    const stale = { ...view, candles: { ...view.candles, '15m': view.candles['15m'].slice(0, -1) } }
    expect(entryFilters(stale, compositeOf(), clear)).toBe('no_candle')
    // Con t = closeTime de la vela vigente (10:14:59.999) también vale.
    expect(entryFilters({ ...view, t: T - 1 }, compositeOf(), clear)).toBeNull()
    expect(entryFilters({ ...stale, t: T - 1 }, compositeOf(), clear)).toBe('no_candle')
  })

  it('precedencia: estado del símbolo antes que el mercado', () => {
    const everything = compositeOf({ higherTrendAgainst: 2, relVolume: 0.1, S: -0.4 })
    expect(entryFilters(viewOf(), everything, { ...clear, degraded: true, hasPosition: true, direction: 'long' })).toBe('no_candle')
    expect(entryFilters(view, everything, { ...clear, degraded: true, hasPosition: true, direction: 'long' })).toBe('degraded')
    expect(entryFilters(view, everything, { ...clear, hasPosition: true, inCooldown: true, direction: 'long' })).toBe('has_position')
    expect(entryFilters(view, everything, { ...clear, inCooldown: true, inPenalty: true, direction: 'long' })).toBe('cooldown')
    expect(entryFilters(view, everything, { ...clear, inPenalty: true, direction: 'long' })).toBe('penalty')
    expect(entryFilters(view, everything, { ...clear, direction: 'long' })).toBe('direction_not_allowed')
    expect(entryFilters(view, everything, clear)).toBe('higher_trend_against')
    expect(entryFilters(view, compositeOf({ relVolume: 0.1, S: -0.4 }), clear)).toBe('low_volume')
  })
})
