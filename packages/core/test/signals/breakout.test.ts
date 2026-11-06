import { describe, expect, it } from 'vitest'
import { breakout } from '../../src/signals/breakout'
import { run, viewOf } from './fixtures'

// 20 velas planas en 100 con mechas ±1 (canal 99–101) y una vela de decisión con cierre `last`.
const channelThen = (last: number) => viewOf({ c15m: run('15m', 21, (i) => (i === 20 ? last : 100), { halfRange: 1 }) })

describe('breakout', () => {
  it('+1 cuando el cierre supera el máximo de las 20 previas', () => {
    const r = breakout(channelThen(102))
    expect(r.id).toBe('breakout')
    expect(r.value).toBe(1)
    expect(r.detail).toMatchObject({ upper: 101, lower: 99, close: 102 })
  })

  it('0 cuando sólo iguala el máximo', () => {
    expect(breakout(channelThen(101)).value).toBe(0)
  })

  it('0 dentro del canal', () => {
    expect(breakout(channelThen(100.5)).value).toBe(0)
  })

  it('−1 cuando cierra por debajo del mínimo', () => {
    expect(breakout(channelThen(98)).value).toBe(-1)
  })

  it('la vela de decisión no entra en su propio canal', () => {
    // Si entrara, su máximo (103) taparía la ruptura.
    const view = channelThen(102)
    expect(view.candles['15m'].at(-1)?.high).toBe(103)
    expect(breakout(view).value).toBe(1)
  })

  it('null con menos de 21 velas', () => {
    expect(breakout(viewOf({ c15m: run('15m', 20, () => 100, { halfRange: 1 }) })).value).toBeNull()
    expect(breakout(viewOf()).value).toBeNull()
  })
})
