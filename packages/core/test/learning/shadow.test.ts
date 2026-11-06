import { describe, expect, it } from 'vitest'
import { compareShadow } from '../../src/learning/shadow'
import { DAY, T0, makeClosed } from './fixtures'

const I0 = 1_000
const NOW = T0 + 30 * DAY

function equityLine(fromPct: number, toPct: number, from: number, to: number, points = 10) {
  return Array.from({ length: points }, (_, i) => {
    const f = i / (points - 1)
    return { at: from + f * (to - from), equity: I0 * (1 + (fromPct + f * (toPct - fromPct)) / 100) }
  })
}

function tradesIn(n: number, r: number, from: number, to: number) {
  const step = (to - from) / n
  return Array.from({ length: n }, (_, i) => makeClosed({ rMultiple: r, openedAt: from + i * step, closedAt: from + i * step + 1 }))
}

describe('compareShadow', () => {
  it('con la sombra 5 pp arriba y 20+ trades en cada una avisa', () => {
    const from = NOW - 14 * DAY
    const learned = { equity: equityLine(0, 2, from, NOW), trades: tradesIn(25, 0.5, from, NOW) }
    const shadow = { equity: equityLine(0, 7, from, NOW), trades: tradesIn(25, 1, from, NOW) }
    const c = compareShadow(learned, shadow, I0, 14, NOW)
    expect(c.gapPp).toBeCloseTo(5, 10)
    expect(c.learnedPp).toBeCloseTo(2, 10)
    expect(c.shadowPp).toBeCloseTo(7, 10)
    expect(c.sumRLearned).toBeCloseTo(12.5, 10)
    expect(c.sumRShadow).toBeCloseTo(25, 10)
    expect(c.enoughTrades).toBe(true)
    expect(c.warn).toBe(true)
  })

  it('sin 20 trades en cada cartera no avisa aunque la brecha sea grande', () => {
    const from = NOW - 14 * DAY
    const learned = { equity: equityLine(0, 2, from, NOW), trades: tradesIn(25, 0.5, from, NOW) }
    const shadow = { equity: equityLine(0, 7, from, NOW), trades: tradesIn(19, 1, from, NOW) }
    const c = compareShadow(learned, shadow, I0, 14, NOW)
    expect(c.gapPp).toBeCloseTo(5, 10)
    expect(c.enoughTrades).toBe(false)
    expect(c.warn).toBe(false)
  })

  it('una brecha de 3 pp o menos no avisa; a favor de lo aprendido tampoco', () => {
    const from = NOW - 14 * DAY
    const trades = tradesIn(30, 0.5, from, NOW)
    const tie = compareShadow({ equity: equityLine(0, 4, from, NOW), trades }, { equity: equityLine(0, 7, from, NOW), trades }, I0, 14, NOW)
    expect(tie.gapPp).toBeCloseTo(3, 10)
    expect(tie.warn).toBe(false)
    const ahead = compareShadow({ equity: equityLine(0, 9, from, NOW), trades }, { equity: equityLine(0, 1, from, NOW), trades }, I0, 14, NOW)
    expect(ahead.gapPp).toBeCloseTo(-8, 10)
    expect(ahead.warn).toBe(false)
  })

  it('mide sólo la ventana: el retorno previo y los trades viejos no cuentan', () => {
    const start = NOW - 30 * DAY
    const from = NOW - 14 * DAY
    // Ambas suben 10 pp antes de la ventana; adentro la sombra sube 6 pp más y lo aprendido 1.
    const learned = {
      equity: [...equityLine(0, 10, start, from - 1), ...equityLine(10, 11, from, NOW)],
      trades: [...tradesIn(50, 1, start, from - 1), ...tradesIn(20, 0.2, from, NOW)],
    }
    const shadow = {
      equity: [...equityLine(0, 10, start, from - 1), ...equityLine(10, 16, from, NOW)],
      trades: [...tradesIn(50, 1, start, from - 1), ...tradesIn(20, 0.4, from, NOW)],
    }
    const c = compareShadow(learned, shadow, I0, 14, NOW)
    expect(c.gapPp).toBeCloseTo(5, 10)
    expect(c.sumRLearned).toBeCloseTo(4, 10)
    expect(c.sumRShadow).toBeCloseTo(8, 10)
    expect(c.tradesLearned).toBe(20)
    expect(c.tradesShadow).toBe(20)
    expect(c.from).toBe(from)
    expect(c.to).toBe(NOW)
    expect(c.warn).toBe(true)
  })

  it('sin `now` usa el último punto de equity de ambas carteras', () => {
    const from = NOW - 14 * DAY
    const c = compareShadow({ equity: equityLine(0, 1, from, NOW), trades: [] }, { equity: equityLine(0, 1, from, NOW - DAY), trades: [] }, I0)
    expect(c.to).toBe(NOW)
    expect(c.from).toBe(from)
  })

  it('sin puntos de equity devuelve 0 y no avisa', () => {
    const c = compareShadow({ equity: [], trades: [] }, { equity: [], trades: [] }, I0, 14, NOW)
    expect(c.gapPp).toBe(0)
    expect(c.warn).toBe(false)
  })
})
