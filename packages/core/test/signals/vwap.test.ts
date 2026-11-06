import { describe, expect, it } from 'vitest'
import { vwap } from '../../src/signals/vwap'
import { candle, utc } from '../market/fixtures'
import { down, flat, run, up, viewOf } from './fixtures'

describe('vwap', () => {
  it('+0,5 con precio arriba del VWAP y VWAP ascendente', () => {
    const r = vwap(viewOf({ c15m: run('15m', 100, up, { halfRange: 1 }) }))
    expect(r.id).toBe('vwap')
    expect(r.value).toBe(0.5)
    expect(r.detail?.close).toBeGreaterThan(r.detail?.vwap ?? Number.NaN)
  })

  it('−0,5 con precio abajo y VWAP descendente', () => {
    expect(vwap(viewOf({ c15m: run('15m', 100, down, { halfRange: 1 }) })).value).toBe(-0.5)
  })

  it('0 cuando el precio cruza (ni arriba subiendo ni abajo bajando)', () => {
    expect(vwap(viewOf({ c15m: run('15m', 100, flat) })).value).toBe(0)
  })

  it('se ancla al día UTC: sólo compara con el VWAP de la vela anterior del mismo día', () => {
    // La serie termina a las 10:00 del 31/10: el VWAP del día arranca a las 00:00. Que
    // ayer haya sido bajista no importa: hoy sube.
    const todayStart = utc(0, 0)
    const series = run('15m', 100, flat, { halfRange: 1 }).map((c, i, all) => {
      const sinceStart = (c.openTime - todayStart) / (15 * 60_000)
      const close = c.openTime < todayStart ? 200 - i : 100 + sinceStart
      const open = i === 0 ? close : all[i - 1]!.openTime < todayStart && c.openTime >= todayStart ? 100 : close - 1
      return { ...c, open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1 }
    })
    expect(vwap(viewOf({ c15m: series })).value).toBe(0.5)
  })

  it('null en la primera vela del día (sin pendiente todavía) y sin velas', () => {
    expect(vwap(viewOf({ c15m: [candle(utc(0, 0), '15m', { close: 101 })] })).value).toBeNull()
    expect(vwap(viewOf({ c15m: [candle(utc(23, 45) - 86_400_000, '15m'), candle(utc(0, 0), '15m', { close: 101 })] })).value).toBeNull()
    expect(vwap(viewOf()).value).toBeNull()
  })

  it('null sin volumen en el día', () => {
    const noVolume = run('15m', 10, up, { volumeOf: () => 0 })
    expect(vwap(viewOf({ c15m: noVolume })).value).toBeNull()
  })
})
