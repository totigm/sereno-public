import { describe, it, expect } from 'vitest'
import { accountRules, checkCapacity } from '../../src/risk/account-rules'
import type { EntryPlan } from '../../src/types'
import { exampleSettings, openPosition, ONE } from './fixtures'

const plan: EntryPlan = {
  side: 'long',
  price: 100,
  distanciaStop: 0.0128,
  riesgoUsd: 10,
  riesgoReal: 10,
  leverage: 5,
  margin: 20,
  notional: 100,
  qty: 1,
  stopPrice: 98.72,
  takeProfitPrice: 102.56,
  liquidationPrice: 80.8,
  multipliers: ONE,
  theta: 0.35,
}
const settings = exampleSettings()
const cap = { side: 'long' as const, plan, capitalBase: 1000, capitalOperable: 1000, settings, mode: 'auto' as const }

describe('checkCapacity (modo auto)', () => {
  it('sin abiertas no bloquea', () => {
    expect(checkCapacity({ ...cap, open: [] })).toBeNull()
  })
  it('5 abiertas ⇒ max_positions', () => {
    const open = [
      openPosition({ side: 'long' }),
      openPosition({ side: 'short' }),
      openPosition({ side: 'long' }),
      openPosition({ side: 'short' }),
      openPosition({ side: 'long' }),
    ]
    expect(checkCapacity({ ...cap, open, side: 'short' })).toBe('max_positions')
  })
  it('3 longs ⇒ max_same_direction para un long, permitido para un short', () => {
    const open = [openPosition({ side: 'long' }), openPosition({ side: 'long' }), openPosition({ side: 'long' })]
    expect(checkCapacity({ ...cap, open, side: 'long' })).toBe('max_same_direction')
    expect(checkCapacity({ ...cap, open, side: 'short' })).toBeNull()
  })
  it('margen en uso 590 + nuevo 20 sobre base 1000 ⇒ max_margin', () => {
    const open = [openPosition({ side: 'short', margin: 300 }), openPosition({ side: 'short', margin: 290 })]
    expect(checkCapacity({ ...cap, open, capitalOperable: 410 })).toBe('max_margin')
    // 580 + 20 = 600 cabe justo
    const justo = [openPosition({ side: 'short', margin: 300 }), openPosition({ side: 'short', margin: 280 })]
    expect(checkCapacity({ ...cap, open: justo, capitalOperable: 420 })).toBeNull()
  })
  it('nocional total 2.950 + nuevo 100 sobre base 1000 ⇒ max_notional', () => {
    const open = [
      openPosition({ side: 'short', margin: 100, notional: 1500 }),
      openPosition({ side: 'short', margin: 100, notional: 1450 }),
    ]
    expect(checkCapacity({ ...cap, open, capitalOperable: 800 })).toBe('max_notional')
  })
  it('capitalOperable < margen nuevo ⇒ insufficient_capital', () => {
    expect(checkCapacity({ ...cap, open: [], capitalOperable: 19 })).toBe('insufficient_capital')
  })
})

describe('checkCapacity (modo custom)', () => {
  const customCap = { ...cap, mode: 'custom' as const, settings: exampleSettings({ custom: { maxPositions: 2 } }) }
  it('usa el máximo de posiciones del modo custom', () => {
    const open = [openPosition({ side: 'short' }), openPosition({ side: 'short' })]
    expect(checkCapacity({ ...customCap, open })).toBe('max_positions')
  })
  it('ignora los topes de margen (60%) y de nocional (3×)', () => {
    const bigPlan: EntryPlan = { ...plan, margin: 500, notional: 5000 }
    const open = [openPosition({ side: 'short', margin: 400, notional: 4000 })]
    expect(checkCapacity({ ...customCap, open, plan: bigPlan, capitalOperable: 600 })).toBeNull()
  })
  it('mantiene la concentración por dirección y el capital operable', () => {
    const open = [openPosition({ side: 'long' }), openPosition({ side: 'long' }), openPosition({ side: 'long' })]
    const roomy = exampleSettings({ custom: { maxPositions: 10 } })
    expect(checkCapacity({ ...customCap, settings: roomy, open })).toBe('max_same_direction')
    expect(checkCapacity({ ...customCap, open: [], capitalOperable: 10 })).toBe('insufficient_capital')
  })
})

describe('accountRules (spec §7)', () => {
  const now = 1_700_000_000_000
  const ok = { capitalBase: 1000, todayRealized: 0, equityPeak: 1000, equity: 1000, consecutiveStops: 0, stopsLastHour: 0, now, settings }

  it('cuenta sana: nada bloquea', () => {
    expect(accountRules(ok)).toEqual({
      blocked: null,
      flags: { dailyLossHit: false, drawdownPause: false, streakPauseUntil: null, globalCooldownUntil: null },
    })
  })
  it('pérdida del día −31 sobre base 1000 ⇒ daily_loss', () => {
    const r = accountRules({ ...ok, todayRealized: -31 })
    expect(r.blocked).toBe('daily_loss')
    expect(r.flags.dailyLossHit).toBe(true)
  })
  it('−29 no llega al 3%; −30 justo sí', () => {
    expect(accountRules({ ...ok, todayRealized: -29 }).blocked).toBeNull()
    expect(accountRules({ ...ok, todayRealized: -30 }).blocked).toBe('daily_loss')
  })
  it('equity 840 con pico 1000 ⇒ drawdownPause', () => {
    const r = accountRules({ ...ok, equity: 840 })
    expect(r.blocked).toBe('drawdown_pause')
    expect(r.flags.drawdownPause).toBe(true)
  })
  it('equity 860 con pico 1000 (14%) no pausa', () => {
    expect(accountRules({ ...ok, equity: 860 }).flags.drawdownPause).toBe(false)
  })
  it('6 stops seguidos ⇒ streakPauseUntil = now + 4h', () => {
    const r = accountRules({ ...ok, consecutiveStops: 6 })
    expect(r.blocked).toBe('streak_pause')
    expect(r.flags.streakPauseUntil).toBe(now + 4 * 3_600_000)
  })
  it('5 stops seguidos no pausan', () => {
    expect(accountRules({ ...ok, consecutiveStops: 5 }).flags.streakPauseUntil).toBeNull()
  })
  it('3 stops en la última hora ⇒ enfriamiento global de 2 velas, con su propio motivo', () => {
    const r = accountRules({ ...ok, stopsLastHour: 3 })
    // 'cooldown' queda para el enfriamiento de una moneda después de su pérdida.
    expect(r.blocked).toBe('global_cooldown')
    expect(r.flags.globalCooldownUntil).toBe(now + 2 * 15 * 60_000)
  })
  it('el drawdown manda sobre la pérdida diaria y la racha', () => {
    const r = accountRules({ ...ok, equity: 840, todayRealized: -100, consecutiveStops: 6 })
    expect(r.blocked).toBe('drawdown_pause')
    expect(r.flags).toMatchObject({ dailyLossHit: true, drawdownPause: true, streakPauseUntil: now + 4 * 3_600_000 })
  })
  it('sin pico de equity no hay drawdown', () => {
    expect(accountRules({ ...ok, equityPeak: 0, equity: 0 }).flags.drawdownPause).toBe(false)
  })
})
