import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { feesOrigin, feesOriginText, type AccountTiersView } from '@/lib/fees-origin'

// 00:10 del 1 de noviembre en Buenos Aires.
const AT = Date.parse('2026-11-01T03:10:00Z')
const TIERS: AccountTiersView = { at: AT, mmrBySymbol: { BTCUSDT: 0.004, SOLUSDT: 0.01 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 }
const APPLIED = { ...DEFAULT_SETTINGS.risk, mmrBySymbol: { SOLUSDT: 0.01, BTCUSDT: 0.004 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 }

describe('feesOrigin', () => {
  it('sin una versión del bot con los datos de la cuenta, son los supuestos', () => {
    expect(feesOrigin(DEFAULT_SETTINGS.risk, null)).toEqual({ source: 'assumptions' })
  })

  it('con los valores que trajo el bot, son de la cuenta (el orden de las claves y el resto del riesgo no cuentan)', () => {
    expect(feesOrigin(APPLIED, TIERS)).toEqual({ source: 'binance', at: AT })
    expect(feesOrigin({ ...APPLIED, riskPerTrade: 0.02 }, TIERS)).toEqual({ source: 'binance', at: AT })
  })

  it('si después cambió un mmr, sobra una moneda o cambió una comisión, están editados', () => {
    expect(feesOrigin({ ...APPLIED, mmrBySymbol: { ...APPLIED.mmrBySymbol, SOLUSDT: 0.02 } }, TIERS)).toEqual({ source: 'edited', at: AT })
    expect(feesOrigin({ ...APPLIED, mmrBySymbol: { ...APPLIED.mmrBySymbol, XRPUSDT: 0.01 } }, TIERS)).toEqual({ source: 'edited', at: AT })
    expect(feesOrigin({ ...APPLIED, takerFeeRate: 0.0005 }, TIERS)).toEqual({ source: 'edited', at: AT })
    expect(feesOrigin(DEFAULT_SETTINGS.risk, TIERS)).toEqual({ source: 'edited', at: AT })
  })
})

describe('feesOriginText', () => {
  it('dice de dónde salen el mmr y las comisiones', () => {
    expect(feesOriginText({ source: 'binance', at: AT })).toBe('Comisiones y mmr: de tu cuenta de Binance · actualizado el 1 de noviembre.')
    expect(feesOriginText({ source: 'assumptions' })).toBe('Comisiones y mmr: supuestos (sin clave de Binance).')
    expect(feesOriginText({ source: 'edited', at: AT })).toBe(
      'Comisiones y mmr: los cambiaste a mano. Los de tu cuenta de Binance (del 1 de noviembre) vuelven con la actualización diaria.',
    )
  })
})
