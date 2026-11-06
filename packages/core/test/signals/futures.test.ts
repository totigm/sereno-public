import { describe, expect, it } from 'vitest'
import { funding, fundingValue } from '../../src/signals/funding'
import { openInterest, openInterestValue } from '../../src/signals/open-interest'
import { positioning, positioningValue } from '../../src/signals/positioning'
import { symbolInfo } from '../market/fixtures'
import { run, snapshot, up, viewOf } from './fixtures'

describe('funding', () => {
  it('−0,5 para longs con fundingRate 0,0008 (contrarian)', () => {
    const r = funding(viewOf({ futures: snapshot({ fundingRate: 0.0008 }) }))
    expect(r.id).toBe('funding')
    expect(r.value).toBe(-0.5)
  })

  it('fundingValue: banda muerta hasta 0,05 %, rampa lineal hasta −0,5 en 0,08 %, simétrico', () => {
    expect(fundingValue(0)).toBe(0)
    expect(fundingValue(0.0001)).toBe(0)
    expect(fundingValue(0.0005)).toBe(0)
    expect(fundingValue(0.00065)).toBeCloseTo(-0.25, 12)
    expect(fundingValue(0.0008)).toBe(-0.5)
    expect(fundingValue(0.003)).toBe(-0.5)
    expect(fundingValue(-0.00065)).toBeCloseTo(0.25, 12)
    expect(fundingValue(-0.0008)).toBe(0.5)
  })

  it('normaliza la tasa a un período de 8 horas según el intervalo del contrato', () => {
    const every4h = { ...viewOf({ futures: snapshot({ fundingRate: 0.0004 }) }), info: { ...symbolInfo(), fundingIntervalHours: 4 } }
    expect(funding(every4h).value).toBe(-0.5)
    expect(funding(every4h).detail?.ratePer8h).toBeCloseTo(0.0008, 12)
  })

  it('null sin snapshot o sin tasa', () => {
    expect(funding(viewOf({ futures: null })).value).toBeNull()
    expect(funding(viewOf({ futures: snapshot({ fundingRate: null }) })).value).toBeNull()
  })
})

describe('openInterest', () => {
  // Cierres 100 + 0,5·i: la vela 19 cierra en 109,5; hace 1h (vela 15) 107,5; hace 4h (vela 3) 101,5.
  const rising = run('15m', 20, up)

  it('+1 si precio y OI suben más de 1 % en 4h (y en 1h)', () => {
    const r = openInterest(viewOf({ c15m: rising, futures: snapshot({ openInterest: 1_030, openInterest1hAgo: 1_000, openInterest4hAgo: 990 }) }))
    expect(r.id).toBe('openInterest')
    expect(r.value).toBe(1)
  })

  it('+0,2 si el precio sube pero el OI baja', () => {
    expect(openInterest(viewOf({ c15m: rising, futures: snapshot({ openInterest: 1_000, openInterest1hAgo: 1_030, openInterest4hAgo: 1_040 }) })).value).toBeCloseTo(0.2, 12)
  })

  it('openInterestValue: magnitud proporcional hasta 1 %, simétrico para bajas', () => {
    expect(openInterestValue(0.02, 0.02)).toBe(1)
    expect(openInterestValue(0.02, 0.005)).toBeCloseTo(0.75, 12)
    expect(openInterestValue(0.005, 0.02)).toBeCloseTo(0.75, 12)
    expect(openInterestValue(0.02, -0.01)).toBeCloseTo(0.2, 12)
    expect(openInterestValue(-0.02, 0.02)).toBe(-1)
    expect(openInterestValue(-0.02, -0.01)).toBeCloseTo(-0.2, 12)
    expect(openInterestValue(0, 0.02)).toBe(0)
    expect(openInterestValue(0.02, 0)).toBe(0)
  })

  it('promedia los horizontes disponibles', () => {
    // 1h: +1 (precio y OI > 1 %); 4h: +0,2 (precio sube, OI baja) ⇒ 0,6.
    expect(openInterest(viewOf({ c15m: rising, futures: snapshot({ openInterest: 1_030, openInterest1hAgo: 1_000, openInterest4hAgo: 1_040 }) })).value).toBeCloseTo(0.6, 12)
    // Sin OI de hace 1h sólo cuenta el horizonte de 4h.
    expect(openInterest(viewOf({ c15m: rising, futures: snapshot({ openInterest: 1_030, openInterest1hAgo: null, openInterest4hAgo: 1_040 }) })).value).toBeCloseTo(0.2, 12)
  })

  it('null sin snapshot, sin OI actual, sin horizontes o sin velas para el precio', () => {
    expect(openInterest(viewOf({ c15m: rising, futures: null })).value).toBeNull()
    expect(openInterest(viewOf({ c15m: rising, futures: snapshot({ openInterest: null }) })).value).toBeNull()
    expect(openInterest(viewOf({ c15m: rising, futures: snapshot({ openInterest1hAgo: null, openInterest4hAgo: null }) })).value).toBeNull()
    expect(openInterest(viewOf({ c15m: run('15m', 4, up), futures: snapshot() })).value).toBeNull()
  })
})

describe('positioning', () => {
  it('positioningValue: extremos contrarian ±0,5, neutro entre 0,5 y 2 inclusive', () => {
    expect(positioningValue(2.5)).toBe(-0.5)
    expect(positioningValue(0.4)).toBe(0.5)
    expect(positioningValue(2)).toBe(0)
    expect(positioningValue(0.5)).toBe(0)
    expect(positioningValue(1)).toBe(0)
  })

  it('promedia el ratio long/short de cuentas y el taker buy/sell', () => {
    const r = positioning(viewOf({ futures: snapshot({ longShortRatio: 2.5, takerRatio: 1 }) }))
    expect(r.id).toBe('positioning')
    expect(r.value).toBeCloseTo(-0.25, 12)
    expect(positioning(viewOf({ futures: snapshot({ longShortRatio: 2.5, takerRatio: 0.3 }) })).value).toBe(0)
    expect(positioning(viewOf({ futures: snapshot({ longShortRatio: 0.3, takerRatio: 0.4 }) })).value).toBe(0.5)
  })

  it('usa el ratio disponible si falta el otro; null sin ninguno', () => {
    expect(positioning(viewOf({ futures: snapshot({ longShortRatio: null, takerRatio: 3 }) })).value).toBe(-0.5)
    expect(positioning(viewOf({ futures: snapshot({ longShortRatio: null, takerRatio: null }) })).value).toBeNull()
    expect(positioning(viewOf({ futures: null })).value).toBeNull()
  })
})
