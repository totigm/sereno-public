import { describe, it, expect } from 'vitest'
import { ceilToStep, floorToStep, planEntry, planCustomEntry } from '../../src/risk/sizing'
import { checkCapacity } from '../../src/risk/account-rules'
import { EPSILON } from '../../src/risk/epsilon'
import type { EntryPlan } from '../../src/types'
import { btcLikeInfo, exampleSettings, ONE } from './fixtures'

/** Invariante de spec §5.5: la liquidación queda a 3 stops o más de la entrada. */
function liquidationAtThreeStops(p: EntryPlan): boolean {
  return Math.abs(p.liquidationPrice - p.price) >= 3 * Math.abs(p.stopPrice - p.price)
}

const base = {
  side: 'long' as const,
  price: 100,
  atr1h: 0.5,
  // Con tick 0,01 el stop (98,72) y el TP (102,56) del ejemplo ya caen en la grilla.
  info: btcLikeInfo({ tickSize: 0.01 }),
  capitalBase: 1000,
  capitalOperable: 1000,
  settings: exampleSettings(),
  multipliers: ONE,
  theta: 0.35,
}

describe('floorToStep', () => {
  it('redondea hacia abajo al múltiplo del step', () => {
    expect(floorToStep(7.8125, 0.001)).toBe(7.812)
    expect(floorToStep(0.6667, 1)).toBe(0)
    expect(floorToStep(123.456, 0.01)).toBe(123.45)
  })
  it('no pierde un múltiplo exacto por error de coma flotante', () => {
    expect(floorToStep(0.3, 0.1)).toBe(0.3)
    expect(floorToStep(100, 0.001)).toBe(100)
  })
  it('ceilToStep redondea hacia arriba sin ganar un step por coma flotante', () => {
    expect(ceilToStep(98.695, 0.01)).toBe(98.7)
    expect(ceilToStep(98.72, 0.1)).toBe(98.8)
    expect(ceilToStep(100 * (1 - 0.0128), 0.01)).toBe(98.72)
    expect(ceilToStep(0.3, 0.1)).toBe(0.3)
  })
  it('acepta un step en notación exponencial (1e-7)', () => {
    expect((1e-7).toString()).toBe('1e-7')
    expect(floorToStep(0.123456789, 1e-7)).toBe(0.1234567)
    expect(floorToStep(0.0000003, 1e-7)).toBe(0.0000003)
  })
  it('con cantidades enormes sigue redondeando hacia abajo, nunca al más cercano', () => {
    // Una moneda de ~1e-6 dólares con step 1 llega a cientos de millones de unidades.
    expect(floorToStep(100000000.95, 1)).toBe(100000000)
    expect(floorToStep(1234567.9999, 0.001)).toBe(1234567.999)
    expect(floorToStep(500000000.6, 1)).toBe(500000000)
    expect(ceilToStep(100000000.05, 1)).toBe(100000001)
  })
})

describe('planEntry (spec §5.5, ejemplo numérico)', () => {
  it('calcula la secuencia completa con los valores del ejemplo', () => {
    const r = planEntry(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = r.plan
    // distanciaStop = max(1,5 × 0,5 / 100 = 0.0075, 8 × 0.0016 = 0.0128)
    expect(p.distanciaStop).toBeCloseTo(0.0128, 6)
    expect(p.riesgoUsd).toBeCloseTo(10, 6)
    // nocional objetivo 781.25; apalancamiento clamp(floor(1/(0.0384+0.01)) = 20, 1, 5) = 5
    expect(p.leverage).toBe(5)
    // qty = floor(781.25 / 100, 0.001) = 7.812 ⇒ nocional final 781.2
    expect(p.qty).toBeCloseTo(7.812, 3)
    expect(p.notional).toBeCloseTo(781.2, 3)
    // margen intermedio 156.25 (< 200); el del plan es el del nocional final: 781.2 / 5
    expect(p.margin).toBeCloseTo(781.2 / 5, 3)
    expect(p.margin).toBeLessThan(200)
    expect(p.riesgoReal).toBeCloseTo(10, 2)
    expect(p.riesgoReal).toBeLessThanOrEqual(p.riesgoUsd)
    expect(p.stopPrice).toBeCloseTo(100 - 0.0128 * 100, 6)
    expect(p.takeProfitPrice).toBeCloseTo(100 + 2 * 0.0128 * 100, 6)
    expect(p.liquidationPrice).toBeCloseTo(80.808, 3)
    // invariante: la liquidación queda a 3 stops o más
    expect(Math.abs(p.liquidationPrice - p.price)).toBeGreaterThanOrEqual(3 * Math.abs(p.stopPrice - p.price))
    expect(p).toMatchObject({ side: 'long', price: 100, multipliers: ONE, theta: 0.35 })
  })

  it('short: stop por arriba, TP por abajo y liquidación por arriba', () => {
    const r = planEntry({ ...base, side: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.stopPrice).toBeCloseTo(101.28, 6)
    expect(r.plan.takeProfitPrice).toBeCloseTo(97.44, 6)
    expect(r.plan.liquidationPrice).toBeCloseTo(118.812, 3)
  })

  it('piso dominante: 8 × costo > 2 × k × ATR / precio ⇒ stop_too_small_for_cost', () => {
    // atr 0.1 ⇒ k × ATR / precio = 0.0015; 8 × 0.0016 = 0.0128 > 2 × 0.0015
    expect(planEntry({ ...base, atr1h: 0.1 })).toEqual({ ok: false, reason: 'stop_too_small_for_cost' })
  })

  it('el piso aplica sin rechazar cuando queda entre 1× y 2× la distancia por ATR', () => {
    // atr 0.6 ⇒ 0.009; piso 0.0128 ∈ [0.009, 0.018] ⇒ d = 0.0128
    const r = planEntry({ ...base, atr1h: 0.6 })
    expect(r.ok && r.plan.distanciaStop).toBeCloseTo(0.0128, 6)
  })

  it('multiplicador 0,5 ⇒ riesgoUsd 5', () => {
    const r = planEntry({ ...base, multipliers: { confidence: 0.5, symbol: 1, btc: 1 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.riesgoUsd).toBeCloseTo(5, 6)
    expect(r.plan.riesgoReal).toBeLessThanOrEqual(5)
  })

  it('los multiplicadores se componen (0,8 × 0,5 × 0,5 ⇒ riesgoUsd 2)', () => {
    const r = planEntry({ ...base, multipliers: { confidence: 0.8, symbol: 0.5, btc: 0.5 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.riesgoUsd).toBeCloseTo(2, 6)
  })

  it('nunca arriesga más del riesgoPorTrade aunque un multiplicador venga > 1', () => {
    const r = planEntry({ ...base, multipliers: { confidence: 1.5, symbol: 1, btc: 1 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.riesgoUsd).toBeCloseTo(10, 6)
  })

  it('minNotional 100 con capital 100 ⇒ below_min_notional', () => {
    // riesgoUsd 1 ⇒ nocional 78.125 < 100
    const r = planEntry({ ...base, info: btcLikeInfo({ minNotional: 100 }), capitalBase: 100, capitalOperable: 100 })
    expect(r).toEqual({ ok: false, reason: 'below_min_notional' })
  })

  it('cantidad por debajo de minQty ⇒ below_min_notional', () => {
    const r = planEntry({ ...base, info: btcLikeInfo({ minQty: 10, minNotional: 1 }) })
    expect(r).toEqual({ ok: false, reason: 'below_min_notional' })
  })

  it('step grueso (stepSize 1, precio 60, nocional objetivo 40) ⇒ below_min_notional', () => {
    // floor(40 / 60, 1) = 0: como la cantidad se redondea siempre hacia abajo, el step
    // nunca sube el riesgo (riesgoReal ≤ riesgoUsd); lo que hace es dejar la cantidad
    // en 0 y por eso el motivo es below_min_notional, no risk_rounding.
    // capitalBase 51.2 ⇒ riesgoUsd 0.512; atr 0.3 ⇒ k×ATR/precio = 0.0075 ⇒ d = 0.0128 ⇒ nocional 40.
    const info = btcLikeInfo({ stepSize: 1, minQty: 1 })
    const r = planEntry({ ...base, info, price: 60, atr1h: 0.3, capitalBase: 51.2, capitalOperable: 51.2 })
    expect(r).toEqual({ ok: false, reason: 'below_min_notional' })
  })

  it('tope de margen: atr 0.05 y capital 100 ⇒ se reduce el nocional y el apalancamiento se mantiene', () => {
    // Sin costos para que el piso no domine: d = 1,5 × 0,05 / 100 = 0.00075;
    // riesgoUsd 1 ⇒ nocional objetivo 1333.33; apalancamiento 5 ⇒ margen 266.67 > 20.
    const settings = exampleSettings({ risk: { takerFeeRate: 0, slippageRate: 0 } })
    // Tick 0,001 para que el stop 99,925 quede en la grilla y no cambie la distancia.
    const info = btcLikeInfo({ halfSpreadRate: 0, tickSize: 0.001 })
    const r = planEntry({ ...base, settings, info, atr1h: 0.05, capitalBase: 100, capitalOperable: 100 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.leverage).toBe(5)
    expect(r.plan.margin).toBeCloseTo(20, 3)
    expect(r.plan.notional).toBeCloseTo(100, 3)
    expect(r.plan.qty).toBeCloseTo(1, 3)
    expect(r.plan.riesgoReal).toBeCloseTo(100 * 0.00075, 6)
    expect(r.plan.riesgoReal).toBeLessThan(r.plan.riesgoUsd)
  })

  it('tope de margen con costos reales y apalancamiento máximo 1', () => {
    // d = 0.0128, riesgoUsd 10 ⇒ nocional 781.25 con L = 1 ⇒ margen 781.25 > 200 ⇒ margen 200, nocional 200.
    const r = planEntry({ ...base, settings: exampleSettings({ risk: { maxLeverage: 1 } }) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.leverage).toBe(1)
    expect(r.plan.margin).toBeCloseTo(200, 3)
    expect(r.plan.notional).toBeCloseTo(200, 3)
  })

  it('el apalancamiento se deriva del stop: stop más ancho ⇒ menos apalancamiento', () => {
    // atr 4 ⇒ d = 0.06 ⇒ floor(1 / (0.18 + 0.01)) = 5; atr 6 ⇒ d = 0.09 ⇒ floor(1 / 0.28) = 3
    const a = planEntry({ ...base, atr1h: 4 })
    const b = planEntry({ ...base, atr1h: 6 })
    expect(a.ok && a.plan.leverage).toBe(5)
    expect(b.ok && b.plan.leverage).toBe(3)
  })

  it('invariante de liquidación: un short al borde del apalancamiento baja un escalón y abre', () => {
    // mmr 0.1, k 1, atr 13 ⇒ d = 0.13 ⇒ L = floor(1 / 0.49) = 2. Para el long la liquidación
    // queda a (0,5 − 0,1) / 0,9 = 44% ≥ 39%; para el short a (0,5 − 0,1) / 1,1 = 36% < 39%,
    // así que el short baja a L = 1: liquidación a (1 − 0,1) / 1,1 = 82% ≥ 39%.
    const settings = exampleSettings({ exits: { k: 1 } })
    const info = btcLikeInfo({ mmr: 0.1 })
    const long = planEntry({ ...base, settings, info, atr1h: 13, side: 'long' })
    const short = planEntry({ ...base, settings, info, atr1h: 13, side: 'short' })
    expect(long.ok && long.plan.leverage).toBe(2)
    expect(short.ok).toBe(true)
    if (!short.ok || !long.ok) return
    expect(short.plan.leverage).toBe(long.plan.leverage - 1)
    expect(short.plan.liquidationPrice).toBeCloseTo((100 * 2) / 1.1, 6)
    expect(liquidationAtThreeStops(short.plan)).toBe(true)
    expect(liquidationAtThreeStops(long.plan)).toBe(true)
  })

  it('rechaza con liquidation_too_close sólo si el invariante falla aun con L = 1', () => {
    // Short con mmr 0,5 y stop al 15%: con L = 1 la liquidación queda a (1 − 0,5) / 1,5 = 33% < 45%.
    const settings = exampleSettings({ exits: { k: 1 } })
    const info = btcLikeInfo({ mmr: 0.5 })
    expect(planEntry({ ...base, settings, info, atr1h: 15, side: 'short' })).toEqual({ ok: false, reason: 'liquidation_too_close' })
  })

  it('mmr no finito o no positivo ⇒ degraded (no liquidation_too_close)', () => {
    for (const mmr of [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.01]) {
      expect(planEntry({ ...base, info: btcLikeInfo({ mmr }) })).toEqual({ ok: false, reason: 'degraded' })
    }
  })

  it('tickSize no finito o no positivo ⇒ degraded', () => {
    for (const tickSize of [Number.NaN, 0, -0.1]) {
      expect(planEntry({ ...base, info: btcLikeInfo({ tickSize }) })).toEqual({ ok: false, reason: 'degraded' })
    }
  })

  it('tick 0,1: stop y TP se redondean hacia la entrada y el riesgo se recalcula con el stop redondeado', () => {
    const long = planEntry({ ...base, info: btcLikeInfo({ tickSize: 0.1 }) })
    expect(long.ok).toBe(true)
    if (!long.ok) return
    // stop 98,72 → 98,8 (más cerca): distancia real 1,2%; TP = 100 × (1 + 2 × 0,012) = 102,4.
    expect(long.plan.stopPrice).toBe(98.8)
    expect(long.plan.distanciaStop).toBeCloseTo(0.012, 12)
    expect(long.plan.takeProfitPrice).toBe(102.4)
    // El tamaño sigue saliendo del stop sin redondear (781,2 de nocional); el riesgo baja.
    expect(long.plan.notional).toBeCloseTo(781.2, 6)
    expect(long.plan.riesgoReal).toBeCloseTo(781.2 * 0.012, 9)
    expect(long.plan.riesgoReal).toBeLessThanOrEqual(long.plan.riesgoUsd)

    const short = planEntry({ ...base, side: 'short', info: btcLikeInfo({ tickSize: 0.1 }) })
    expect(short.ok).toBe(true)
    if (!short.ok) return
    // stop 101,28 → 101,2; TP = 100 × (1 − 0,024) = 97,6.
    expect(short.plan.stopPrice).toBe(101.2)
    expect(short.plan.distanciaStop).toBeCloseTo(0.012, 12)
    expect(short.plan.takeProfitPrice).toBe(97.6)
    expect(short.plan.riesgoReal).toBeLessThanOrEqual(short.plan.riesgoUsd)
  })

  it('tick 0,01: un stop fuera de la grilla se acerca un tick y el TP sale de la distancia real', () => {
    // atr 0,87 ⇒ d = 1,5 × 0,87 / 100 = 0,01305 ⇒ stop 98,695 → 98,70 ⇒ distancia real 1,3%.
    const r = planEntry({ ...base, atr1h: 0.87 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.stopPrice).toBe(98.7)
    expect(r.plan.distanciaStop).toBeCloseTo(0.013, 12)
    expect(r.plan.takeProfitPrice).toBe(102.6)
    // nocional = floor(10 / 0,01305 / 100, 0,001) × 100 = 766,2
    expect(r.plan.notional).toBeCloseTo(766.2, 6)
    expect(r.plan.riesgoReal).toBeCloseTo(766.2 * 0.013, 9)
    expect(r.plan.riesgoReal).toBeLessThanOrEqual(r.plan.riesgoUsd)
    expect(liquidationAtThreeStops(r.plan)).toBe(true)
  })

  it('si redondear al tick deja el stop sobre la entrada ⇒ stop_too_small_for_cost', () => {
    // Tick 2: el stop 98,72 hacia la entrada es 100.
    expect(planEntry({ ...base, info: btcLikeInfo({ tickSize: 2 }) })).toEqual({ ok: false, reason: 'stop_too_small_for_cost' })
    // Entrada fuera de la grilla (100,05) con tick 0,1: el stop 98,77 sube a 98,8 y sigue abajo.
    const r = planEntry({ ...base, price: 100.05, info: btcLikeInfo({ tickSize: 0.1 }) })
    expect(r.ok && r.plan.stopPrice).toBe(98.8)
    // Sin costos y con un stop de 0,015%: 100,035 sube a 100,1, del otro lado de la entrada.
    const settings = exampleSettings({ risk: { takerFeeRate: 0, slippageRate: 0 } })
    const info = btcLikeInfo({ tickSize: 0.1, halfSpreadRate: 0 })
    expect(planEntry({ ...base, settings, info, price: 100.05, atr1h: 0.01 })).toEqual({ ok: false, reason: 'stop_too_small_for_cost' })
  })

  it('usa la misma tolerancia que checkCapacity para insufficient_capital', () => {
    const r = planEntry(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { margin } = r.plan
    const capacity = (capitalOperable: number) =>
      checkCapacity({ open: [], side: 'long', plan: r.plan, capitalBase: 1000, capitalOperable, settings: base.settings, mode: 'auto' })
    // Un residuo de coma flotante por debajo del margen no bloquea en ninguno de los dos.
    const residue = margin - EPSILON / 2
    expect(planEntry({ ...base, capitalOperable: residue }).ok).toBe(true)
    expect(capacity(residue)).toBeNull()
    // Pasada la tolerancia, bloquean los dos.
    const short = margin - 2 * EPSILON
    expect(planEntry({ ...base, capitalOperable: short })).toEqual({ ok: false, reason: 'insufficient_capital' })
    expect(capacity(short)).toBe('insufficient_capital')
  })

  it('el margen final tiene que caber en capitalOperable', () => {
    expect(planEntry({ ...base, capitalOperable: 100 })).toEqual({ ok: false, reason: 'insufficient_capital' })
  })

  it('sin capital base no hay plan', () => {
    expect(planEntry({ ...base, capitalBase: 0, capitalOperable: 0 })).toEqual({ ok: false, reason: 'insufficient_capital' })
  })

  it('precio o ATR inválidos ⇒ no_candle', () => {
    expect(planEntry({ ...base, price: 0 })).toEqual({ ok: false, reason: 'no_candle' })
    expect(planEntry({ ...base, atr1h: Number.NaN })).toEqual({ ok: false, reason: 'no_candle' })
  })
})

describe('planCustomEntry (modo "yo fijo tamaño y salidas")', () => {
  const custom = {
    side: 'long' as const,
    price: 100,
    info: btcLikeInfo(),
    capitalBase: 100,
    capitalOperable: 100,
    settings: exampleSettings({ custom: { marginPerTrade: { kind: 'usd', value: 50 }, leverage: 5, slPct: 0.02, tpPct: 0.04 } }),
    theta: 0.35,
  }

  it('"long 5x con 50 USD" sobre 100: margen fijo, apalancamiento fijo y SL/TP en % de precio', () => {
    const r = planCustomEntry(custom)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = r.plan
    expect(p.leverage).toBe(5)
    expect(p.margin).toBeCloseTo(50, 6)
    expect(p.notional).toBeCloseTo(250, 6)
    expect(p.qty).toBeCloseTo(2.5, 6)
    expect(p.distanciaStop).toBe(0.02)
    expect(p.stopPrice).toBeCloseTo(98, 6)
    expect(p.takeProfitPrice).toBeCloseTo(104, 6)
    // riesgoReal = nocional × SL%
    expect(p.riesgoReal).toBeCloseTo(5, 6)
    expect(p.riesgoUsd).toBeCloseTo(5, 6)
    expect(p.liquidationPrice).toBeCloseTo(80.808, 3)
    expect(p.multipliers).toEqual(ONE)
    expect(p.theta).toBe(0.35)
  })

  it('margen en % del capital base', () => {
    const settings = exampleSettings({ custom: { marginPerTrade: { kind: 'pct', value: 0.1 }, leverage: 3 } })
    const r = planCustomEntry({ ...custom, settings, capitalBase: 1000, capitalOperable: 1000 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.margin).toBeCloseTo(100, 6)
    expect(r.plan.notional).toBeCloseTo(300, 6)
  })

  it('short: stop por arriba y TP por abajo', () => {
    const r = planCustomEntry({ ...custom, side: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.stopPrice).toBeCloseTo(102, 6)
    expect(r.plan.takeProfitPrice).toBeCloseTo(96, 6)
    expect(r.plan.liquidationPrice).toBeCloseTo(118.812, 3)
  })

  it('redondea la cantidad al step y recalcula margen y nocional', () => {
    // 50 × 5 / 100 = 2.5 con step 1 ⇒ 2 ⇒ nocional 200, margen 40
    const r = planCustomEntry({ ...custom, info: btcLikeInfo({ stepSize: 1, minQty: 1 }) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.qty).toBe(2)
    expect(r.plan.notional).toBeCloseTo(200, 6)
    expect(r.plan.margin).toBeCloseTo(40, 6)
    expect(r.plan.riesgoReal).toBeCloseTo(4, 6)
  })

  it('no aplica el tope del 20% de margen por trade', () => {
    const r = planCustomEntry(custom) // 50 sobre 100 = 50%
    expect(r.ok).toBe(true)
  })

  it('capitalOperable < margen ⇒ insufficient_capital', () => {
    expect(planCustomEntry({ ...custom, capitalOperable: 30 })).toEqual({ ok: false, reason: 'insufficient_capital' })
  })

  it('mínimos del contrato ⇒ below_min_notional', () => {
    expect(planCustomEntry({ ...custom, info: btcLikeInfo({ minNotional: 300 }) })).toEqual({ ok: false, reason: 'below_min_notional' })
  })

  it('SL más allá de la liquidación ⇒ liquidation_too_close', () => {
    // 5x con mmr 1% ⇒ liquidación a 19,2%; un SL al 25% queda después.
    const settings = exampleSettings({ custom: { marginPerTrade: { kind: 'usd', value: 50 }, leverage: 5, slPct: 0.25, tpPct: 0.04 } })
    expect(planCustomEntry({ ...custom, settings })).toEqual({ ok: false, reason: 'liquidation_too_close' })
  })

  it('precio inválido ⇒ no_candle', () => {
    expect(planCustomEntry({ ...custom, price: 0 })).toEqual({ ok: false, reason: 'no_candle' })
  })

  it('mmr o tickSize inválidos ⇒ degraded', () => {
    expect(planCustomEntry({ ...custom, info: btcLikeInfo({ mmr: Number.NaN }) })).toEqual({ ok: false, reason: 'degraded' })
    expect(planCustomEntry({ ...custom, info: btcLikeInfo({ tickSize: 0 }) })).toEqual({ ok: false, reason: 'degraded' })
  })

  it('SL y TP se redondean al tick hacia la entrada', () => {
    // SL 1,234% ⇒ 98,766 → 98,8 (distancia 1,2%); TP 4,321% ⇒ 104,321 → 104,3.
    const settings = exampleSettings({ custom: { marginPerTrade: { kind: 'usd', value: 50 }, leverage: 5, slPct: 0.01234, tpPct: 0.04321 } })
    const r = planCustomEntry({ ...custom, settings })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.stopPrice).toBe(98.8)
    expect(r.plan.takeProfitPrice).toBe(104.3)
    expect(r.plan.distanciaStop).toBeCloseTo(0.012, 12)
    expect(r.plan.riesgoReal).toBeCloseTo(250 * 0.012, 9)
  })

  it('el margen usa la misma tolerancia que checkCapacity', () => {
    expect(planCustomEntry({ ...custom, capitalOperable: 50 - EPSILON / 2 }).ok).toBe(true)
    expect(planCustomEntry({ ...custom, capitalOperable: 50 - 2 * EPSILON })).toEqual({ ok: false, reason: 'insufficient_capital' })
  })
})
