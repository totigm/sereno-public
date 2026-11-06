import { describe, it, expect } from 'vitest'
import { SettingsSchema, DEFAULT_SETTINGS, sameAccountTiers, sameMmrTable } from '../src/settings'

describe('SettingsSchema', () => {
  it('acepta los valores por defecto', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })
  it('tiene los defaults del documento', () => {
    expect(DEFAULT_SETTINGS.capital.protectPct).toBe(0.7)
    expect(DEFAULT_SETTINGS.risk.riskPerTrade).toBe(0.01)
    expect(DEFAULT_SETTINGS.risk.maxLeverage).toBe(5)
    expect(DEFAULT_SETTINGS.exits).toMatchObject({ k: 2, tpR: 2, trailingR: 1, trailingActivationR: 1, timeExitHours: 48, timeExitMinR: 0.3, stopFloorCostMultiple: 8 })
    expect(DEFAULT_SETTINGS.entry.theta).toBe(0.55)
    expect(DEFAULT_SETTINGS.risk.dailyLossLimit).toBe(0.03)
    expect(DEFAULT_SETTINGS.risk.maxDrawdown).toBe(0.15)
    expect(DEFAULT_SETTINGS.learning).toMatchObject({ confidenceAlpha: 0.2, penaltyThreshold: -0.4, penaltyMinTrades: 8, penaltyDays: 7 })
  })
  it('rechaza apalancamiento custom fuera de 1..20', () => {
    expect(() => SettingsSchema.parse({ ...DEFAULT_SETTINGS, custom: { ...DEFAULT_SETTINGS.custom, leverage: 50 } })).toThrow()
  })
  it('rechaza protectPct fuera de 0..1', () => {
    expect(() => SettingsSchema.parse({ ...DEFAULT_SETTINGS, capital: { ...DEFAULT_SETTINGS.capital, protectPct: 1.5 } })).toThrow()
  })
})

describe('risk.lossCap', () => {
  it('lossCap por defecto es 1 (apagado)', () => {
    expect(DEFAULT_SETTINGS.risk.lossCap).toBe(1)
  })
  it('completa lossCap en ajustes viejos', () => {
    const { lossCap: _omitido, ...riskViejo } = DEFAULT_SETTINGS.risk
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS, risk: riskViejo }).risk.lossCap).toBe(1)
  })
  it('rechaza lossCap fuera de 0,1..1', () => {
    for (const lossCap of [0.05, 1.2]) {
      expect(() => SettingsSchema.parse({ ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap } })).toThrow()
    }
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.1 } }).risk.lossCap).toBe(0.1)
  })
})

describe('sameMmrTable', () => {
  it('iguales aunque las claves vengan en otro orden (jsonb las reordena)', () => {
    expect(sameMmrTable({ BTCUSDT: 0.004, SOLUSDT: 0.01 }, { SOLUSDT: 0.01, BTCUSDT: 0.004 })).toBe(true)
    expect(sameMmrTable({}, {})).toBe(true)
  })

  it('distintas si cambia un valor o sobra o falta una moneda', () => {
    expect(sameMmrTable({ BTCUSDT: 0.004 }, { BTCUSDT: 0.005 })).toBe(false)
    expect(sameMmrTable({ BTCUSDT: 0.004 }, { BTCUSDT: 0.004, SOLUSDT: 0.01 })).toBe(false)
    expect(sameMmrTable({ BTCUSDT: 0.004, SOLUSDT: 0.01 }, { BTCUSDT: 0.004 })).toBe(false)
    expect(sameMmrTable({ BTCUSDT: 0.004 }, { ETHUSDT: 0.004 })).toBe(false)
  })
})

describe('sameAccountTiers', () => {
  const applied = { ...DEFAULT_SETTINGS.risk, mmrBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.0065, SOLUSDT: 0.01 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 }

  it('compara el mmr sin mirar el orden de las claves', () => {
    expect(sameAccountTiers(applied, { ...applied, mmrBySymbol: { SOLUSDT: 0.01, ETHUSDT: 0.0065, BTCUSDT: 0.004 } })).toBe(true)
    expect(sameAccountTiers(applied, { ...applied, mmrBySymbol: { ...applied.mmrBySymbol, SOLUSDT: 0.015 } })).toBe(false)
  })

  it('distintos si cambia una comisión', () => {
    expect(sameAccountTiers(applied, { ...applied, takerFeeRate: 0.0005 })).toBe(false)
    expect(sameAccountTiers(applied, { ...applied, makerFeeRate: 0.0002 })).toBe(false)
  })

  it('mira sólo mmr y comisiones: otro campo del riesgo no cuenta', () => {
    const otherRisk = { ...applied, riskPerTrade: 0.02 }
    expect(sameAccountTiers(applied, otherRisk)).toBe(true)
  })
})
