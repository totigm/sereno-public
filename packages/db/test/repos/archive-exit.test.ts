import { describe, expect, it } from 'vitest'
import { defaultHalfSpread, exitAtMark } from '../../src/repos/archive-exit'
import { position } from './fixtures'

const COSTOS = { takerFeeRate: 0.0005, slippageRate: 0.0002, halfSpreadRate: 0.00025 }
const AT = Date.parse('2026-10-31T15:00:00Z')

describe('exitAtMark', () => {
  it('long: vende al marca menos medio spread y slippage, y descuenta las dos comisiones', () => {
    // SOL long 2 a 125 (nocional 250, comisión de entrada 0,125), marca 130.
    const c = exitAtMark(position('p'), 130, COSTOS, AT)
    expect(c.exitPrice).toBeCloseTo(129.9415, 10)
    expect(c.pnlGross).toBeCloseTo(9.883, 10)
    expect(c.feesPaid).toBeCloseTo(0.125 + 0.1299415, 10)
    expect(c.pnlNet).toBeCloseTo(9.6280585, 10)
    expect(c.rMultiple).toBeCloseTo(9.6280585 / 5, 10)
    expect(c.closeReason).toBe('session_archived')
    expect(c.closedAt).toBe(AT)
  })

  it('el desglose cuenta las dos patas, igual que las comisiones', () => {
    const c = exitAtMark(position('p'), 130, COSTOS, AT)
    // Salida sobre 260 de nocional y entrada sobre 250.
    expect(c.costs.fees).toBeCloseTo(0.125 + 0.1299415, 10)
    expect(c.costs.spread).toBeCloseTo(260 * 0.00025 + 250 * 0.00025, 10)
    expect(c.costs.slippage).toBeCloseTo(260 * 0.0002 + 250 * 0.0002, 10)
  })

  it('short: compra al marca más los costos y el funding pagado resta', () => {
    const p = position('p', { symbol: 'BTCUSDT', side: 'short', entryPrice: 70_000, qty: 0.01, notional: 700, feesPaid: 0.35, fundingPaid: 0.1, riesgoReal: 7 })
    const c = exitAtMark(p, 69_000, { ...COSTOS, halfSpreadRate: 0.00005 }, AT)
    expect(c.exitPrice).toBeCloseTo(69_017.25, 8)
    expect(c.pnlGross).toBeCloseTo(9.8275, 8)
    expect(c.pnlNet).toBeCloseTo(9.8275 - (0.35 + 0.34508625) - 0.1, 8)
    expect(c.costs.funding).toBe(0.1)
  })

  it('con nocional grande suma 0,01% de slippage por cada 10.000 USDT, en las dos patas', () => {
    // BTC long 1 a 70.000, marca 72.000: 7 escalones en las dos patas ⇒ slippage 0,09%.
    const p = position('p', { symbol: 'BTCUSDT', entryPrice: 70_000, qty: 1, notional: 70_000, feesPaid: 35, riesgoReal: 700 })
    const c = exitAtMark(p, 72_000, { ...COSTOS, halfSpreadRate: 0.0001 }, AT)
    expect(c.exitPrice).toBeCloseTo(71_928, 8)
    expect(c.pnlGross).toBeCloseTo(1_928, 8)
    expect(c.feesPaid).toBeCloseTo(35 + 35.964, 8)
    expect(c.costs.spread).toBeCloseTo(7.2 + 7, 8)
    expect(c.costs.slippage).toBeCloseTo(64.8 + 63, 8)
  })

  it('cada pata paga el escalón de su propio nocional', () => {
    // ETH long 4 a 2.400 (nocional 9.600, sin escalón), marca 2.600: la salida
    // vale 10.400 y paga un escalón ⇒ slippage 0,03% contra 0,02% de la entrada.
    const p = position('p', { symbol: 'ETHUSDT', entryPrice: 2_400, qty: 4, notional: 9_600, feesPaid: 4.8, riesgoReal: 96 })
    const c = exitAtMark(p, 2_600, { ...COSTOS, halfSpreadRate: 0.0001 }, AT)
    // 2.600 × (1 − 0,0001 − 0,0003)
    expect(c.exitPrice).toBeCloseTo(2_598.96, 8)
    expect(c.pnlGross).toBeCloseTo(795.84, 8)
    // Entrada 4,8 y salida 2.598,96 × 4 × 0,0005 = 5,19792.
    expect(c.costs.fees).toBeCloseTo(9.99792, 8)
    expect(c.pnlNet).toBeCloseTo(785.84208, 8)
    expect(c.rMultiple).toBeCloseTo(785.84208 / 96, 8)
    expect(c.costs.spread).toBeCloseTo(1.04 + 0.96, 8)
    expect(c.costs.slippage).toBeCloseTo(10_400 * 0.0003 + 9_600 * 0.0002, 8)
    expect(c.costs.funding).toBe(0)
  })
})

describe('defaultHalfSpread', () => {
  it('0,01% en BTC y ETH, 0,025% en el resto', () => {
    expect(defaultHalfSpread('BTCUSDT')).toBe(0.0001)
    expect(defaultHalfSpread('ETHUSDT')).toBe(0.0001)
    expect(defaultHalfSpread('SOLUSDT')).toBe(0.00025)
  })
})
