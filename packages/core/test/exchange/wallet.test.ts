import { describe, it, expect } from 'vitest'
import { Wallet } from '../../src/exchange/wallet'

describe('Wallet', () => {
  it('suma y resta mientras el saldo alcanza', () => {
    const w = new Wallet(100)
    expect(w.apply(-30)).toEqual({ applied: -30, shortfall: 0 })
    expect(w.apply(5)).toEqual({ applied: 5, shortfall: 0 })
    expect(w.total).toBe(75)
    expect(w.totalShortfall).toBe(0)
  })

  it('nunca baja de 0: recorta y acumula el faltante', () => {
    const w = new Wallet(10)
    expect(w.apply(-25)).toEqual({ applied: -10, shortfall: 15 })
    expect(w.total).toBe(0)
    expect(w.apply(-1)).toEqual({ applied: 0, shortfall: 1 })
    expect(w.totalShortfall).toBe(16)
    expect(w.apply(3)).toEqual({ applied: 3, shortfall: 0 })
    expect(w.total).toBe(3)
  })

  it('rechaza un saldo inicial negativo o no finito y montos no finitos', () => {
    expect(() => new Wallet(-1)).toThrow(/saldo/)
    expect(() => new Wallet(Number.POSITIVE_INFINITY)).toThrow(/saldo/)
    expect(() => new Wallet(0).apply(Number.NaN)).toThrow(/monto/)
  })
})
