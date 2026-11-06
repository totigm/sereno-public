import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { exitRulesFor } from '../../src/engine/exits'
import { canonicalPath, resolveCandle, segmentPoints } from '../../src/replay/intra-candle'
import { candleOf, INTRA_CANDLE_CASES } from './cases'

describe('resolveCandle — orden canónico intra-vela (spec §6)', () => {
  for (const c of INTRA_CANDLE_CASES) {
    it(c.name, () => {
      const exits = exitRulesFor(c.position, DEFAULT_SETTINGS, 0.01)
      const outcome = resolveCandle(c.position, c.last, c.mark ?? c.last, exits)
      const { exitPrice, ...rest } = c.expected
      expect(outcome).toMatchObject(rest)
      if (exitPrice === null) expect(outcome.exitPrice).toBeNull()
      else expect(outcome.exitPrice).toBeCloseTo(exitPrice, 9)
    })
  }

  it('no muta la posición que recibe', () => {
    const [first] = INTRA_CANDLE_CASES
    if (!first) throw new Error('sin casos')
    const before = structuredClone(first.position)
    resolveCandle(first.position, first.last, first.last, exitRulesFor(first.position, DEFAULT_SETTINGS, 0.01))
    expect(first.position).toEqual(before)
  })
})

describe('canonicalPath', () => {
  const last = candleOf({ o: 100, h: 103, l: 98, c: 101 })
  const mark = candleOf({ o: 100.1, h: 102.9, l: 98.2, c: 101.1 })

  it('long: apertura → mínimo → máximo → cierre, con la marca y el último de cada vértice', () => {
    expect(canonicalPath('long', last, mark)).toEqual({
      open: { mark: 100.1, last: 100 },
      adverse: { mark: 98.2, last: 98 },
      favorable: { mark: 102.9, last: 103 },
      close: { mark: 101.1, last: 101 },
    })
  })

  it('short: apertura → máximo → mínimo → cierre', () => {
    const path = canonicalPath('short', last, mark)
    expect(path.adverse).toEqual({ mark: 102.9, last: 103 })
    expect(path.favorable).toEqual({ mark: 98.2, last: 98 })
  })
})

describe('segmentPoints', () => {
  it('bajando: los niveles cruzados de arriba hacia abajo, sin los extremos, y al final el vértice', () => {
    const points = segmentPoints({ mark: 100, last: 100 }, { mark: 98, last: 98 }, [99, 98.5, 100, 98, 101, 99])
    expect(points).toEqual([
      { mark: 99, last: 99 },
      { mark: 98.5, last: 98.5 },
      { mark: 98, last: 98 },
    ])
  })

  it('subiendo: de abajo hacia arriba', () => {
    const points = segmentPoints({ mark: 98, last: 98 }, { mark: 100, last: 100 }, [99.5, 98.5])
    expect(points.map((p) => p.mark)).toEqual([98.5, 99.5, 100])
  })

  it('el último se interpola en la misma fracción del tramo que la marca', () => {
    const [point] = segmentPoints({ mark: 100, last: 100.2 }, { mark: 98, last: 98.6 }, [99])
    // La marca recorrió la mitad del tramo: el último está a mitad entre 100,2 y 98,6.
    expect(point?.mark).toBe(99)
    expect(point?.last).toBeCloseTo(99.4, 12)
  })

  it('un tramo plano no cruza niveles', () => {
    expect(segmentPoints({ mark: 100, last: 100 }, { mark: 100, last: 99.9 }, [100, 99])).toEqual([{ mark: 100, last: 99.9 }])
  })
})
