import { describe, expect, it } from 'vitest'
import { checkLossFloor, lossFloor, worstCaseEquity } from '../../src/risk/loss-floor'
import type { EntryPlan } from '../../src/types'
import { exampleSettings, ONE, openPosition } from './fixtures'

// Taker 0,05% y slippage 0,02%: la entrada a mercado paga taker + slippage y la salida
// por el stop (condicional) taker + dos slippages, como el simulador.
const RISK = { takerFeeRate: 0.0005, slippageRate: 0.0002 }
const ENTRY_RATE = 0.0005 + 0.0002
const EXIT_RATE = 0.0005 + 2 * 0.0002

const plan: EntryPlan = {
  side: 'long',
  price: 10,
  distanciaStop: 0.04,
  riesgoUsd: 0.4,
  riesgoReal: 0.4,
  leverage: 5,
  margin: 2,
  notional: 10,
  qty: 1,
  stopPrice: 9.6,
  takeProfitPrice: 10.8,
  liquidationPrice: 8.1,
  multipliers: ONE,
  theta: 0.55,
}
// Lo que el plan puede restar en el peor caso: su riesgo, la entrada y la salida a su stop.
const PLAN_WORST = plan.riesgoReal + plan.notional * ENTRY_RATE + plan.qty * plan.stopPrice * EXIT_RATE

describe('lossFloor', () => {
  it('apagado con tope 1, sin tope o con un tope que no es número', () => {
    expect(lossFloor(1000, 1)).toBeNull()
    expect(lossFloor(1000, undefined)).toBeNull()
    expect(lossFloor(1000, Number.NaN)).toBeNull()
  })

  it('con plata real nunca se apaga: al 100% el piso es 0', () => {
    expect(lossFloor(1000, 1, true)).toBe(0)
    expect(lossFloor(1000, 0.5, true)).toBe(500)
    expect(lossFloor(1000, undefined, true)).toBe(0)
    expect(lossFloor(1000, Number.NaN, true)).toBe(0)
  })

  it('prendido, el piso es capital × (1 − tope)', () => {
    expect(lossFloor(50, 0.5)).toBe(25)
    expect(lossFloor(1000, 0.1)).toBeCloseTo(900, 9)
  })
})

describe('worstCaseEquity', () => {
  it('un long abierto pierde hasta su stop más la salida condicional', () => {
    const long = openPosition({ side: 'long', qty: 1, entryPrice: 100, stopPrice: 95 })
    expect(worstCaseEquity({ saldo: 50, open: [long], risk: RISK })).toBeCloseTo(50 - 5 - 95 * (0.0005 + 0.0004), 12)
  })

  it('un short cuenta la distancia al revés', () => {
    const short = openPosition({ side: 'short', qty: 2, entryPrice: 100, stopPrice: 104 })
    expect(worstCaseEquity({ saldo: 50, open: [short], risk: RISK })).toBeCloseTo(50 - 8 - 208 * EXIT_RATE, 12)
  })

  it('un stop ya movido a ganancia suma (no resta) en el peor caso', () => {
    const protegida = openPosition({ side: 'long', qty: 1, entryPrice: 100, stopPrice: 103 })
    const worst = worstCaseEquity({ saldo: 50, open: [protegida], risk: RISK })
    expect(worst).toBeCloseTo(50 + 3 - 103 * EXIT_RATE, 12)
    expect(worst).toBeGreaterThan(50)
  })

  it('el plan nuevo resta su riesgo, la entrada y la salida a su stop', () => {
    expect(worstCaseEquity({ saldo: 50, open: [], plan, risk: RISK })).toBeCloseTo(50 - PLAN_WORST, 12)
    expect(PLAN_WORST).toBeCloseTo(0.4 + 10 * ENTRY_RATE + 9.6 * EXIT_RATE, 12)
  })

  it('sin abiertas ni plan es el saldo', () => {
    expect(worstCaseEquity({ saldo: 50, open: [], risk: RISK })).toBe(50)
  })
})

describe('checkLossFloor', () => {
  const settings = exampleSettings({ risk: { lossCap: 0.5 } })

  it('bloquea si el plan deja el peor caso un centavo bajo el piso y deja pasar uno un centavo arriba', () => {
    const open = [openPosition({ side: 'short', qty: 0.1, entryPrice: 20, stopPrice: 20.5 })]
    const openWorst = 0.1 * 0.5 + 0.1 * 20.5 * EXIT_RATE
    // Capital 50 y tope 50%: el piso es 25.
    const atFloor = 25 + openWorst + PLAN_WORST
    expect(checkLossFloor({ capitalInicial: 50, saldo: atFloor - 0.01, open, plan, settings })).toBe('loss_floor')
    expect(checkLossFloor({ capitalInicial: 50, saldo: atFloor + 0.01, open, plan, settings })).toBeNull()
  })

  it('con el tope en 1 nunca bloquea', () => {
    const off = exampleSettings({ risk: { lossCap: 1 } })
    expect(checkLossFloor({ capitalInicial: 50, saldo: 0.5, open: [], plan, settings: off })).toBeNull()
  })
})
