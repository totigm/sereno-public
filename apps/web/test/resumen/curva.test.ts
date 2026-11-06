import { describe, expect, it, vi } from 'vitest'
import { CHART_W, equityGeometry, nearestIndex, splitRuns } from '@/components/charts/equity-geometry'
import { rangeTone, valueRows, withLivePoint } from '@/components/resumen/equity-series'
import type { EquityCurve } from '@/lib/queries/equity-curve'
import { DAY, HOUR, point } from './fixtures'

// La geometría de la curva de equity y la serie que se dibuja (spec §11.1).

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const T0 = Date.UTC(2026, 9, 30, 3, 0)
const MIN = 60_000

const base = { showSaldo: false, showShadow: false, trailingGapMs: Number.POSITIVE_INFINITY }

describe('equityGeometry', () => {
  it('la curva va sólida donde los puntos son continuos y punteada en un hueco de más de 5 minutos', () => {
    const points = [point(T0, 1000), point(T0 + MIN, 1002), point(T0 + 20 * MIN, 1010, { gapBefore: true }), point(T0 + 21 * MIN, 1012)]
    expect(splitRuns(points).map((r) => r.length)).toEqual([2, 2])
    const g = equityGeometry({ ...base, points, from: T0, to: T0 + 21 * MIN })
    const x = (at: number) => g?.x(at) ?? Number.NaN
    expect(g?.solid).toEqual([
      { x1: x(T0), x2: x(T0 + MIN) },
      { x1: x(T0 + 20 * MIN), x2: x(T0 + 21 * MIN) },
    ])
    expect(g?.gaps).toEqual([{ x1: x(T0 + MIN), x2: x(T0 + 20 * MIN) }])
    expect(g?.line).toMatch(/^M/)
    expect(g?.dot).toBeNull()
  })

  it('un solo punto se dibuja como punto', () => {
    const g = equityGeometry({ ...base, points: [point(T0, 1000)], from: T0 - HOUR, to: T0 + HOUR })
    expect(g?.dot).not.toBeNull()
    expect(g?.solid).toEqual([])
  })

  it('sin puntos al final (bot caído) dibuja el hueco hasta el borde', () => {
    const points = [point(T0, 1000), point(T0 + MIN, 1001)]
    const g = equityGeometry({ ...base, points, from: T0, to: T0 + HOUR, trailingGapMs: 5 * MIN })
    expect(g?.trailing?.x2).toBe(CHART_W)
    const fresh = equityGeometry({ ...base, points, from: T0, to: T0 + 2 * MIN, trailingGapMs: 5 * MIN })
    expect(fresh?.trailing).toBeNull()
  })

  it('el saldo y la sombra sólo si se piden; la sombra sin datos no se dibuja', () => {
    const points = [point(T0, 1000, { saldo: 990 }), point(T0 + MIN, 1005, { saldo: 995 })]
    expect(equityGeometry({ ...base, points, from: T0, to: T0 + MIN })?.saldo).toBeNull()
    expect(equityGeometry({ ...base, showSaldo: true, points, from: T0, to: T0 + MIN })?.saldo).toMatch(/^M/)
    expect(equityGeometry({ ...base, showShadow: true, points, from: T0, to: T0 + MIN })?.shadow).toBeNull()
  })

  it('el punto más cercano', () => {
    const points = [point(T0, 1), point(T0 + 10 * MIN, 2), point(T0 + 20 * MIN, 3)]
    expect(nearestIndex(points, T0 + 4 * MIN)).toBe(0)
    expect(nearestIndex(points, T0 + 6 * MIN)).toBe(1)
    expect(nearestIndex(points, T0 + 99 * MIN)).toBe(2)
  })
})

function curve(points: EquityCurve['points']): EquityCurve {
  return { from: T0, to: T0 + DAY, bucketMs: 0, points }
}

describe('la serie que se dibuja', () => {
  it('suma el punto de ahora para que el final coincida con el titular', () => {
    const drawn = withLivePoint(curve([point(T0, 1000)]), { at: T0 + 2 * DAY, equity: 1010, saldo: 1000, shadowEquity: null })
    expect(drawn.points).toHaveLength(2)
    expect(drawn.points[1]?.gapBefore).toBe(false)
    expect(drawn.to).toBe(T0 + 2 * DAY)
  })

  it('a un rango vacío no le agrega un punto suelto, ni uno viejo', () => {
    expect(withLivePoint(curve([]), { at: T0, equity: 1, saldo: 1, shadowEquity: null }).points).toEqual([])
    expect(withLivePoint(curve([point(T0, 1000)]), { at: T0 - 1, equity: 1, saldo: 1, shadowEquity: null }).points).toHaveLength(1)
  })

  it('el color sigue lo que hizo la curva en el rango', () => {
    expect(rangeTone([point(T0, 1000), point(T0 + MIN, 990)])).toBe('loss')
    expect(rangeTone([point(T0, 1000), point(T0 + MIN, 1000)])).toBe('gain')
  })

  it('la tabla: el cierre de cada día, lo más nuevo primero', () => {
    const points = [point(T0 + HOUR, 1000), point(T0 + 5 * HOUR, 1005), point(T0 + DAY + HOUR, 1020)]
    const rows = valueRows(points, '7d')
    expect(rows.map((r) => r.point.equity)).toEqual([1020, 1005])
    expect(rows[1]?.at).toBe(T0)
  })
})
