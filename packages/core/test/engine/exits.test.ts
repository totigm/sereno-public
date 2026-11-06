import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import {
  crossedExit,
  exitRulesFor,
  nextStop,
  shouldSignalExit,
  shouldTimeExit,
  stopCloseReason,
  unrealizedR,
} from '../../src/engine/exits'
import { openPosition } from '../risk/fixtures'

const HOUR = 3_600_000
const AUTO = { exits: DEFAULT_SETTINGS.exits, custom: DEFAULT_SETTINGS.custom }
const TICK = 0.01

// Long del brief: entrada 100, distancia de stop 1% (1R = 1 de precio), stop en 99.
const long = (overrides = {}) =>
  openPosition({ side: 'long', entryPrice: 100, distanciaStop: 0.01, stopPrice: 99, takeProfitPrice: 105, bestPrice: 100, qty: 2, riesgoReal: 2, ...overrides })
const short = (overrides = {}) =>
  openPosition({ side: 'short', entryPrice: 100, distanciaStop: 0.01, stopPrice: 101, takeProfitPrice: 95, bestPrice: 100, qty: 2, riesgoReal: 2, ...overrides })

describe('nextStop (trailing, spec §5.6)', () => {
  const rules = (p = long()) => exitRulesFor(p, AUTO, TICK)

  it('long entrada 100, d 1%: con marca 101 (+1R) el stop va a la entrada', () => {
    expect(nextStop(long(), 101, rules())).toBe(100)
  })

  it('long entrada 100, d 1%: con marca 103 el stop sigue a 1R del mejor precio (102)', () => {
    const atBreakeven = long({ stopPrice: 100, bestPrice: 101, trailingActive: true })
    expect(nextStop(atBreakeven, 103, rules(atBreakeven))).toBe(102)
  })

  it('debajo de +1R no se mueve', () => {
    expect(nextStop(long(), 100.99, rules())).toBeNull()
  })

  it('nunca retrocede: si la marca baja, el stop queda donde estaba', () => {
    const trailed = long({ stopPrice: 102, bestPrice: 103, trailingActive: true })
    expect(nextStop(trailed, 102.5, rules(trailed))).toBeNull()
  })

  it('short simétrico: marca 99 ⇒ stop a la entrada; marca 97 ⇒ 98', () => {
    expect(nextStop(short(), 99, exitRulesFor(short(), AUTO, TICK))).toBe(100)
    const atBreakeven = short({ stopPrice: 100, bestPrice: 99, trailingActive: true })
    expect(nextStop(atBreakeven, 97, exitRulesFor(atBreakeven, AUTO, TICK))).toBe(98)
  })

  it('el stop nuevo queda en la grilla del tick, redondeado hacia la marca', () => {
    // 1R = 1,5 de precio: mejor precio 103,104 ⇒ 101,604 ⇒ 101,61 con tick 0,01.
    const p = long({ distanciaStop: 0.015, stopPrice: 100, bestPrice: 102, trailingActive: true })
    expect(nextStop(p, 103.104, exitRulesFor(p, AUTO, TICK))).toBe(101.61)
  })

  it('con trailingR 1,5 al pasar +1R el stop no queda peor que la entrada', () => {
    const wide = exitRulesFor(long(), { ...AUTO, exits: { ...AUTO.exits, trailingR: 1.5 } }, TICK)
    expect(nextStop(long(), 101, wide)).toBe(100)
    expect(nextStop(long({ stopPrice: 100, bestPrice: 101, trailingActive: true }), 103, wide)).toBe(101.5)
  })

  it('modo custom sin trailing ⇒ nunca mueve el stop', () => {
    const p = long({ mode: 'custom' })
    expect(nextStop(p, 110, exitRulesFor(p, { ...AUTO, custom: { ...AUTO.custom, trailingPct: null } }, TICK))).toBeNull()
  })

  it('modo custom con trailing 2%: se activa al avanzar 2% (stop a la entrada) y sigue a 2% del mejor precio', () => {
    const p = long({ mode: 'custom', distanciaStop: 0.02, stopPrice: 98 })
    const rulesCustom = exitRulesFor(p, { ...AUTO, custom: { ...AUTO.custom, trailingPct: 0.02 } }, TICK)
    expect(nextStop(p, 101.99, rulesCustom)).toBeNull()
    expect(nextStop(p, 102, rulesCustom)).toBe(100)
    expect(nextStop({ ...p, stopPrice: 100, bestPrice: 102, trailingActive: true }, 105, rulesCustom)).toBe(103)
  })
})

describe('shouldTimeExit (spec §5.6: 48 h sin superar +0,3R)', () => {
  const p = long({ openedAt: 0 })
  const rules = exitRulesFor(p, AUTO, TICK)

  it('49 h con +0,1R ⇒ cierra', () => {
    expect(shouldTimeExit(p, 49 * HOUR, 0.1, rules)).toBe(true)
  })

  it('49 h con +0,5R ⇒ sigue', () => {
    expect(shouldTimeExit(p, 49 * HOUR, 0.5, rules)).toBe(false)
  })

  it('47 h con −0,5R ⇒ todavía no', () => {
    expect(shouldTimeExit(p, 47 * HOUR, -0.5, rules)).toBe(false)
  })

  it('justo en +0,3R a las 48 h ⇒ cierra ("no supera")', () => {
    expect(shouldTimeExit(p, 48 * HOUR, 0.3, rules)).toBe(true)
  })

  it('modo custom ⇒ sin salida por tiempo', () => {
    const custom = long({ mode: 'custom', openedAt: 0 })
    expect(shouldTimeExit(custom, 100 * HOUR, -1, exitRulesFor(custom, AUTO, TICK))).toBe(false)
  })
})

describe('shouldSignalExit (spec §5.6: S′ del otro lado más allá de θ_apertura / 2)', () => {
  it('long con θ de apertura 0,35 y S′ = −0,2 ⇒ cierra', () => {
    const p = long({ thetaAtOpen: 0.35 })
    expect(shouldSignalExit(p, -0.2, exitRulesFor(p, AUTO, TICK))).toBe(true)
  })

  it('long con S′ = −0,1 (no llega a −0,175) ⇒ sigue', () => {
    const p = long({ thetaAtOpen: 0.35 })
    expect(shouldSignalExit(p, -0.1, exitRulesFor(p, AUTO, TICK))).toBe(false)
  })

  it('short simétrico: S′ = +0,2 ⇒ cierra; S′ = −0,6 ⇒ sigue', () => {
    const p = short({ thetaAtOpen: 0.35 })
    expect(shouldSignalExit(p, 0.2, exitRulesFor(p, AUTO, TICK))).toBe(true)
    expect(shouldSignalExit(p, -0.6, exitRulesFor(p, AUTO, TICK))).toBe(false)
  })

  it('usa el θ guardado en la posición, no el vigente', () => {
    const p = long({ thetaAtOpen: 0.5 })
    expect(shouldSignalExit(p, -0.2, exitRulesFor(p, AUTO, TICK))).toBe(false)
  })

  it('modo custom ⇒ sin salida por señal', () => {
    const p = long({ mode: 'custom' })
    expect(shouldSignalExit(p, -1, exitRulesFor(p, AUTO, TICK))).toBe(false)
  })
})

describe('unrealizedR, crossedExit y stopCloseReason', () => {
  it('R no realizado bruto a la marca sobre el riesgo real', () => {
    expect(unrealizedR(long(), 100.5)).toBeCloseTo(0.5, 12)
    expect(unrealizedR(short(), 100.5)).toBeCloseTo(-0.5, 12)
  })

  it('la marca que toca el stop o el take profit, con el mismo criterio inclusivo que el exchange', () => {
    expect(crossedExit(long(), 99)).toBe('stop')
    expect(crossedExit(long(), 99.01)).toBeNull()
    expect(crossedExit(long(), 105)).toBe('take_profit')
    expect(crossedExit(short(), 101)).toBe('stop')
    expect(crossedExit(short(), 95)).toBe('take_profit')
    expect(crossedExit(long({ takeProfitPrice: null }), 1_000)).toBeNull()
  })

  it('un stop ya movido por el trailing cierra como trailing_stop', () => {
    expect(stopCloseReason(long())).toBe('stop')
    expect(stopCloseReason(long({ trailingActive: true }))).toBe('trailing_stop')
  })
})
