import { describe, expect, it } from 'vitest'
import { LevelBook } from '../../src/replay/level-book'
import type { ClosedPosition, Fill, Position } from '../../src/types'
import { positionOf } from '../engine/fixtures'

const FILL: Fill = { symbol: 'SOLUSDT', side: 'buy', price: 100, qty: 2, fee: 0, at: 0, spreadCost: 0, slippageCost: 0 }

const closedOf = (p: Position): ClosedPosition => ({
  ...p,
  closedAt: 0,
  exitPrice: 100,
  closeReason: 'stop',
  pnlGross: 0,
  pnlNet: 0,
  rMultiple: 0,
  costs: { fees: 0, spread: 0, slippage: 0, funding: 0 },
})

describe('LevelBook', () => {
  it('lleva stop, liquidación y take profit de las abiertas de las dos carteras a partir de los eventos', () => {
    const book = new LevelBook()
    const real = positionOf('SOLUSDT', { id: 'r' })
    const shadow = positionOf('SOLUSDT', { id: 's', shadow: true, side: 'short', stopPrice: 103, takeProfitPrice: 94, liquidationPrice: 118 })
    book.apply({ type: 'position_opened', position: shadow, fill: FILL, phrase: '' })
    book.apply({ type: 'position_opened', position: real, fill: FILL, phrase: '' })
    expect(book.symbols()).toEqual(['SOLUSDT'])
    // La vela se recorre con el lado de lo real aunque la sombra haya abierto antes.
    expect(book.pathSide('SOLUSDT')).toBe('long')
    // La sombra está del lado contrario: para ella ese recorrido no es el peor caso.
    expect(book.opposed('SOLUSDT')).toBe(true)
    expect(book.levels('SOLUSDT')).toEqual([103, 118, 94, 99, real.liquidationPrice, 105])

    book.apply({ type: 'stop_moved', positionId: 'r', from: 99, to: 100, at: 0, phrase: '' })
    expect(book.levels('SOLUSDT')).toContain(100)
    book.apply({ type: 'position_closed', position: closedOf(real), fill: FILL, phrase: '' })
    expect(book.pathSide('SOLUSDT')).toBe('short')
    expect(book.opposed('SOLUSDT')).toBe(false)
    book.apply({ type: 'position_closed', position: closedOf(shadow), fill: FILL, phrase: '' })
    expect(book.has('SOLUSDT')).toBe(false)
    expect(book.symbols()).toEqual([])
  })
})
