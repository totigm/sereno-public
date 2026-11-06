import { describe, expect, it } from 'vitest'
import { adxModifier, btcVolatilityMultiplier, relativeVolume, sizingConfidence, volumeModifier } from '../../src/signals/modifiers'
import { compositeOf, emptyBtc, run, up } from './fixtures'

describe('adxModifier', () => {
  it('0,5 con ADX 15; 1 entre 20 y 40; 1,1 por encima de 40', () => {
    expect(adxModifier(15)).toBe(0.5)
    expect(adxModifier(19.99)).toBe(0.5)
    expect(adxModifier(20)).toBe(1)
    expect(adxModifier(40)).toBe(1)
    expect(adxModifier(40.01)).toBe(1.1)
  })

  it('neutro (1) sin dato', () => {
    expect(adxModifier(Number.NaN)).toBe(1)
    expect(adxModifier(null)).toBe(1)
  })
})

describe('volumeModifier', () => {
  it('recorta el volumen relativo a [0,7, 1,2]', () => {
    expect(volumeModifier(3)).toBe(1.2)
    expect(volumeModifier(0.5)).toBe(0.7)
    expect(volumeModifier(1)).toBe(1)
    expect(volumeModifier(1.1)).toBeCloseTo(1.1, 12)
  })
})

describe('relativeVolume', () => {
  it('volumen de la última vela sobre la media de las 96 anteriores', () => {
    const candles = run('15m', 97, up, { volumeOf: (i) => (i === 96 ? 30 : 10) })
    expect(relativeVolume(candles)).toBe(3)
  })

  it('usa exactamente las 96 anteriores aunque haya más historia', () => {
    const candles = run('15m', 300, up, { volumeOf: (i) => (i === 299 ? 30 : i < 203 ? 1_000 : 10) })
    expect(relativeVolume(candles)).toBe(3)
  })

  it('null sin 96 velas previas o con media cero', () => {
    expect(relativeVolume(run('15m', 96, up))).toBeNull()
    expect(relativeVolume(run('15m', 97, up, { volumeOf: (i) => (i === 96 ? 30 : 0) }))).toBeNull()
    expect(relativeVolume([])).toBeNull()
  })
})

describe('btcVolatilityMultiplier (modificador de tamaño, spec §5.3c)', () => {
  it('0,5 si la volatilidad 24h de BTC supera 2 × su media de 30 días', () => {
    expect(btcVolatilityMultiplier({ ...emptyBtc, realizedVol24h: 0.081, realizedVol30dMean: 0.04 })).toBe(0.5)
  })

  it('1 en el límite (2 × exacto) y por debajo', () => {
    expect(btcVolatilityMultiplier({ ...emptyBtc, realizedVol24h: 0.08, realizedVol30dMean: 0.04 })).toBe(1)
    expect(btcVolatilityMultiplier({ ...emptyBtc, realizedVol24h: 0.03, realizedVol30dMean: 0.04 })).toBe(1)
  })

  it('1 mientras falte historia de BTC', () => {
    expect(btcVolatilityMultiplier(emptyBtc)).toBe(1)
    expect(btcVolatilityMultiplier({ ...emptyBtc, realizedVol24h: 0.2 })).toBe(1)
  })
})

describe('sizingConfidence (modificador de tamaño, spec §5.3c)', () => {
  it('la confianza del compuesto si ningún marco mayor está en contra', () => {
    expect(sizingConfidence(compositeOf({ confidence: 0.6, higherTrendAgainst: 0 }))).toBe(0.6)
  })

  it('a la mitad si uno solo de 1h/4h está en contra', () => {
    expect(sizingConfidence(compositeOf({ confidence: 0.6, higherTrendAgainst: 1 }))).toBeCloseTo(0.3, 12)
  })

  it('con los dos en contra no se entra (filtro), pero el valor sigue siendo la mitad', () => {
    expect(sizingConfidence(compositeOf({ confidence: 0.6, higherTrendAgainst: 2 }))).toBeCloseTo(0.3, 12)
  })
})
