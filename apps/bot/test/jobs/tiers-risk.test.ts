import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { withAccountTiers, type AccountTiers } from '../../src/jobs/tiers-risk'

const RISK = DEFAULT_SETTINGS.risk
const TIERS: AccountTiers = {
  mmr: new Map([
    ['SOLUSDT', 0.01],
    ['BTCUSDT', 0.004],
    ['ETHUSDT', 0.0065],
    ['ZZZUSDT', 0.03],
  ]),
  takerFeeRate: 0.00045,
  makerFeeRate: 0.00018,
}
const CATALOG = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])

describe('withAccountTiers', () => {
  it('pisa el mmr de las monedas del catálogo que trajo Binance y las comisiones; el resto del riesgo queda', () => {
    const next = withAccountTiers(RISK, TIERS, CATALOG)
    expect(next).toEqual({ ...RISK, mmrBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.0065, SOLUSDT: 0.01 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 })
    expect(next.mmrDefault).toBe(RISK.mmrDefault)
  })

  it('las claves quedan ordenadas (el historial no cambia por el orden)', () => {
    expect(Object.keys(withAccountTiers(RISK, TIERS, CATALOG).mmrBySymbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
  })

  it('conserva el mmr de una moneda que Binance ya no devuelve (un contrato deslistado con una abierta)', () => {
    const risk = { ...RISK, mmrBySymbol: { ...RISK.mmrBySymbol, OLDUSDT: 0.05 } }
    expect(withAccountTiers(risk, TIERS, new Set([...CATALOG, 'OLDUSDT'])).mmrBySymbol.OLDUSDT).toBe(0.05)
  })

  it('no toca el riesgo de entrada', () => {
    const before = structuredClone(RISK)
    withAccountTiers(RISK, TIERS, CATALOG)
    expect(RISK).toEqual(before)
  })
})
