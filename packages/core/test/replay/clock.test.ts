import { describe, expect, it } from 'vitest'
import { isParamTuningSlot, SimClock, utcDay } from '../../src/replay/clock'

describe('SimClock', () => {
  it('avanza o se queda, pero no retrocede', () => {
    const clock = new SimClock(1_000)
    clock.advance(1_000)
    clock.advance(2_000)
    expect(clock.now).toBe(2_000)
    expect(() => clock.advance(1_999)).toThrow(RangeError)
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError)
  })
})

describe('calendario del replay', () => {
  it('el día del universo es el día UTC, no el local', () => {
    expect(utcDay(Date.UTC(2026, 9, 4, 23, 59, 59, 999))).toBe('2026-10-04')
    expect(utcDay(Date.UTC(2026, 9, 5))).toBe('2026-10-05')
  })

  it('el ajuste semanal cae sólo en la vela de los domingos a las 00:30 UTC', () => {
    // 4/10/2026 es domingo.
    expect(isParamTuningSlot(Date.UTC(2026, 9, 4, 0, 30))).toBe(true)
    expect(isParamTuningSlot(Date.UTC(2026, 9, 4, 0, 45))).toBe(false)
    expect(isParamTuningSlot(Date.UTC(2026, 9, 3, 0, 30))).toBe(false)
    expect(isParamTuningSlot(Date.UTC(2026, 9, 11, 0, 30))).toBe(true)
  })
})
