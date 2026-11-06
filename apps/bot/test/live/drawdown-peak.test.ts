import { describe, expect, it } from 'vitest'
import { AccountGuard, initialGuardState } from '@sereno/core/src/engine/account-guard'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { drawdownPeak, type EquityAggregates, type SettingsVersion } from '../../src/live/drawdown-peak'

const S = Date.UTC(2026, 9, 30, 0, 0, 0)
const H = 3_600_000
const END = S + 1_000 * H

const running = DEFAULT_SETTINGS
const pausedBy = (by: 'user' | 'auto'): Settings => ({ ...DEFAULT_SETTINGS, pause: { paused: true, by, at: null, reason: null } })

interface CurvePoint {
  at: number
  equity: number
}

function versions(...list: [at: number, settings: Settings][]): SettingsVersion[] {
  return list.map(([at, settings], i) => ({ version: i + 1, at, settings }))
}

function curve(...list: [at: number, equity: number][]): CurvePoint[] {
  return list.map(([at, equity]) => ({ at, equity }))
}

// Los agregados de la base sobre una curva en memoria (misma semántica que `repos.equity`).
function inMemory(points: readonly CurvePoint[]): EquityAggregates {
  const within = (from: number, to: number) => points.filter((p) => p.at >= from && p.at < to)
  return {
    peak: async (from, to) => {
      const inside = within(from, to)
      return inside.length === 0 ? null : Math.max(...inside.map((p) => p.equity))
    },
    drawdownHit: async (from, to, priorPeak, maxDrawdown) => {
      let peak = priorPeak
      for (const p of within(from, to)) {
        peak = Math.max(peak ?? p.equity, p.equity)
        if (peak > 0 && (peak - p.equity) / peak >= maxDrawdown) return true
      }
      return false
    },
  }
}

// Lo que se hacía antes de los agregados: repetir el `AccountGuard` sobre la curva entera.
function guardReplay(startedAt: number, list: readonly SettingsVersion[], points: readonly CurvePoint[]): number | null {
  const ordered = [...list].sort((a, b) => a.version - b.version)
  const guard = new AccountGuard(initialGuardState(startedAt), { drawdown: 'pause' })
  let settings = ordered[0]!.settings
  let next = 1
  const applyUntil = (at: number) => {
    for (; next < ordered.length && ordered[next]!.at <= at; next++) {
      if (settings.pause.paused && !ordered[next]!.settings.pause.paused) guard.resume()
      settings = ordered[next]!.settings
    }
  }
  for (const point of points) {
    applyUntil(point.at)
    guard.evaluate({ now: point.at, capitalBase: 0, equity: point.equity, settings })
  }
  applyUntil(Number.POSITIVE_INFINITY)
  return guard.snapshot().equityPeak
}

const peakOf = (list: SettingsVersion[], points: CurvePoint[]) => drawdownPeak(S, END, list, inMemory(points))

describe('drawdownPeak', () => {
  it('sin pausas es el máximo de la curva', async () => {
    expect(await peakOf(versions([S, running]), curve([S + H, 1_100], [S + 2 * H, 1_300], [S + 3 * H, 1_250]))).toBe(1_300)
  })

  it('una pausa de Toti (o del blindaje) y su reanudación no vuelven a medir el pico', async () => {
    const history = versions([S, running], [S + 2 * H, pausedBy('user')], [S + 3 * H, running], [S + 4 * H, pausedBy('auto')], [S + 5 * H, running])
    expect(await peakOf(history, curve([S + H, 1_300], [S + 2 * H, 1_250], [S + 3 * H + 1, 1_240], [S + 5 * H + 1, 1_245]))).toBe(1_300)
  })

  it('levantar una pausa por drawdown vuelve a medir el pico desde ahí', async () => {
    // 1.300 → 1.100 es una caída del 15,4 %: el motor se pausó y Toti reanudó a las 3 h.
    const history = versions([S, running], [S + 2 * H + 1, pausedBy('auto')], [S + 3 * H, running])
    expect(await peakOf(history, curve([S + H, 1_300], [S + 2 * H, 1_100], [S + 3 * H + 1, 1_120], [S + 4 * H, 1_150], [S + 5 * H, 1_140]))).toBe(1_150)
  })

  it('el drawdown se mide con el máximo vigente en cada versión', async () => {
    // Con el corte en 20 % la caída del 15,4 % no pausa: reanudar no toca el pico.
    const loose: Settings = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, maxDrawdown: 0.2 } }
    const pausedLoose: Settings = { ...loose, pause: { paused: true, by: 'user', at: null, reason: null } }
    const history = versions([S, loose], [S + 2 * H + 1, pausedLoose], [S + 3 * H, loose])
    expect(await peakOf(history, curve([S + H, 1_300], [S + 2 * H, 1_100], [S + 3 * H + 1, 1_120]))).toBe(1_300)
  })

  it('sin curva no hay pico', async () => {
    expect(await peakOf(versions([S, running]), [])).toBeNull()
  })

  it('da lo mismo que repetir el AccountGuard sobre la curva entera', async () => {
    // Generador determinista (LCG) de curvas e historias de ajustes con pausas y cortes distintos.
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const cuts = [0.05, 0.1, 0.15, 0.2]
    // Escenarios donde alguna reanudación volvió a medir el pico: sin ellos la comparación no prueba nada.
    let remeasured = 0
    for (let scenario = 0; scenario < 300; scenario++) {
      const points: CurvePoint[] = []
      let equity = 1_000
      for (let i = 0; i < 60; i++) {
        equity = Math.max(1, equity * (1 + (random() - 0.5) * 0.12))
        points.push({ at: S + i * H + (random() < 0.2 ? 0 : 1), equity })
      }
      const list: [number, Settings][] = [[S, running]]
      let paused = false
      for (let at = S + 2 * H; at < S + 60 * H; at += Math.floor(1 + random() * 8) * H) {
        paused = !paused
        const risk = { ...DEFAULT_SETTINGS.risk, maxDrawdown: cuts[Math.floor(random() * cuts.length)]! }
        list.push([at, { ...DEFAULT_SETTINGS, risk, pause: { paused, by: paused ? 'auto' : null, at: null, reason: null } }])
      }
      const history = versions(...list)
      const expected = guardReplay(S, history, points)
      expect(await peakOf(history, points)).toBe(expected)
      if (expected !== Math.max(...points.map((p) => p.equity))) remeasured++
    }
    expect(remeasured).toBeGreaterThan(50)
  })
})
