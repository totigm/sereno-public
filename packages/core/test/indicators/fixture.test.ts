import { describe, it, expect } from 'vitest'
import { fixtureCandles, syntheticCandle, FIXTURE_T0, HOUR_MS } from './synthetic'

// El JSON es la fuente de los valores esperados (calculados con un oráculo
// independiente); este test garantiza que las velas del JSON siguen siendo
// exactamente las que produce la fórmula documentada en `synthetic.ts`.
describe('fixture de indicadores', () => {
  it('tiene 60 velas de 1h consecutivas que empiezan a las 20:00 UTC', () => {
    expect(fixtureCandles).toHaveLength(60)
    expect(fixtureCandles[0]?.openTime).toBe(FIXTURE_T0)
    for (let i = 1; i < fixtureCandles.length; i++) {
      expect(fixtureCandles[i]?.openTime).toBe(FIXTURE_T0 + i * HOUR_MS)
      expect(fixtureCandles[i]?.closeTime).toBe(FIXTURE_T0 + (i + 1) * HOUR_MS - 1)
    }
  })

  it('cada vela coincide con la fórmula de syntheticCandle(i)', () => {
    fixtureCandles.forEach((candle, i) => {
      expect(candle).toEqual(syntheticCandle(i))
    })
  })

  it('los primeros cierres son los calculados a mano: 100, 103,5, 107, 103,5, 107, …', () => {
    expect(fixtureCandles.slice(0, 11).map((c) => c.close)).toEqual([100, 103.5, 107, 103.5, 107, 103.5, 107, 103.5, 107, 110.5, 107])
  })
})
