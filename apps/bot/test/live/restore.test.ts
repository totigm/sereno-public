import { describe, expect, it } from 'vitest'
import type { ClosedPosition, CloseReason } from '@sereno/core'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { planRestore, type RestoreInput } from '../../src/live/restore'
import { openPosition } from '../helpers/engine-fixtures'

const START = Date.UTC(2026, 9, 30, 12, 0, 0)
const MIN = 60_000

function closed(i: number, reason: CloseReason, pnlNet: number, overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  const p = openPosition({ id: `c${i}`, symbol: 'SOLUSDT', openedAt: START + i * 60 * MIN })
  return { ...p, closedAt: p.openedAt + 30 * MIN, exitPrice: 145, closeReason: reason, pnlGross: pnlNet, pnlNet, rMultiple: pnlNet / p.riesgoReal, costs: { fees: 0.3, spread: 0, slippage: 0, funding: 0 }, ...overrides }
}

function input(overrides: Partial<RestoreInput> = {}): RestoreInput {
  return {
    session: { capitalInicial: 1000, protegido: 0, baseBlindaje: 1000, startedAt: START },
    settings: DEFAULT_SETTINGS,
    open: [],
    closed: [],
    lastFlags: null,
    equityPeak: null,
    ...overrides,
  }
}

describe('planRestore', () => {
  it('el saldo es I₀ más lo realizado: neto de los cerrados y lo ya pagado por las abiertas', () => {
    const eth = openPosition({ id: 'o1', symbol: 'ETHUSDT', feesPaid: 0.5, fundingPaid: 0.25 })
    const plan = planRestore(
      input({
        open: [{ position: eth, entryCosts: { spread: 0.1, slippage: 0.2 }, tickSize: 0.01 }],
        closed: [closed(1, 'take_profit', 20), closed(2, 'stop', -10), closed(3, 'stop', -5, { shadow: true })],
        session: { capitalInicial: 1000, protegido: 0, baseBlindaje: 1000, startedAt: START },
      }),
    )
    expect(plan.real.saldo).toBeCloseTo(1000 + 20 - 10 - 0.75, 9)
    expect(plan.shadow.saldo).toBeCloseTo(995, 9)
    expect(plan.state.real.positions).toEqual([{ position: eth, entryCosts: { spread: 0.1, slippage: 0.2 }, tickSize: 0.01 }])
  })

  it('la pérdida del día no carga los costos de entrada y el funding de una posición abierta otro día', () => {
    // Abierta el 30-oct a las 22:00 de Buenos Aires, con 0,5 de comisión de entrada y 0,3 de
    // funding esa misma noche; cerrada el 31-oct a las 10:00 con un neto de −10.
    const openedAt = Date.UTC(2026, 9, 31, 1, 0)
    const closedAt = Date.UTC(2026, 9, 31, 13, 0)
    const overnight = closed(1, 'stop', -10, { id: 'overnight', openedAt, closedAt, feesPaid: 0.8 })
    const costs = new Map([['overnight', [{ at: openedAt, amount: -0.5 }, { at: openedAt + 60 * MIN, amount: -0.3 }]]])
    const guard = planRestore(input({ closed: [overnight], closedCosts: costs })).state.real.guard
    // En vivo, ese día sólo realizó el cierre: −10 + 0,5 + 0,3.
    expect(guard.dayStart).toBe(Date.UTC(2026, 9, 31, 3, 0))
    expect(guard.dayRealized).toBeCloseTo(-9.2, 9)
    // Sin los costos, todo el neto cuenta en el cierre (lo de antes, para filas sin eventos).
    expect(planRestore(input({ closed: [overnight] })).state.real.guard.dayRealized).toBeCloseTo(-10, 9)
  })

  it('la racha, los stops de la última hora y el enfriamiento salen de los cierres', () => {
    const plan = planRestore(input({ closed: [closed(1, 'take_profit', 20), closed(2, 'stop', -10), closed(3, 'stop', -10)] }))
    const guard = plan.state.real.guard
    expect(guard.consecutiveStops).toBe(2)
    expect(guard.cooldownUntil.SOLUSDT).toBe(START + 3 * 60 * MIN + 30 * MIN + 4 * 15 * MIN)
  })

  it('una racha que llegó al máximo deja la pausa por racha armada', () => {
    const stops = Array.from({ length: 6 }, (_, i) => closed(i, 'stop', -5, { closedAt: START + (i + 1) * 5 * MIN }))
    const guard = planRestore(input({ closed: stops })).state.real.guard
    expect(guard.consecutiveStops).toBe(0)
    expect(guard.streakPauseUntil).toBe(START + 30 * MIN + DEFAULT_SETTINGS.risk.streakPauseHours * 60 * MIN)
  })

  it('la pausa por drawdown viene del último latido y el pico es el que se le pasa (sólo a lo real)', () => {
    const flags = { btcVolExtreme: false, dailyLossHit: false, drawdownPause: true, streakPause: false, learningFrozen: false }
    const plan = planRestore(input({ lastFlags: flags, equityPeak: 1200 }))
    expect(plan.state.real.guard).toMatchObject({ drawdownPaused: true, equityPeak: 1200 })
    expect(plan.state.shadow?.guard).toMatchObject({ drawdownPaused: false, equityPeak: null })
  })

  it('la sombra re-aprende su confianza y su blindaje con sus propios cierres', () => {
    const wins = [closed(1, 'take_profit', 400, { shadow: true }), closed(2, 'take_profit', 400, { shadow: true })]
    const plan = planRestore(input({ closed: wins }))
    expect(plan.shadow).toEqual({ saldo: 1800, protegido: 1000, baseBlindaje: 1000 })
    expect(plan.state.shadow?.learning.confidenceBySymbol.SOLUSDT).toBeGreaterThan(0)
    expect(plan.state.shadow?.learning.tradesBySymbol.SOLUSDT).toBe(2)
  })
})
