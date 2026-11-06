// El pico de equity del drawdown máximo al retomar una sesión. El motor lo vuelve a medir
// sólo cuando Toti levanta una pausa por drawdown (`AccountGuard.resume`); reanudar de una
// pausa suya o de la del capital blindado no lo toca, porque borrarlo aflojaría el corte.
// La base no guarda el pico: es el máximo de la curva desde la última reanudación que
// levantó una pausa por drawdown (o desde el inicio). Una reanudación la levantó si,
// entre el pico anterior y ella, la curva cayó el máximo de la versión de ajustes vigente
// en cada punto (la regla de `accountRules`, la misma del `AccountGuard`).
//
// Las reanudaciones son pocas (una por versión de ajustes); la curva, de hasta ~130 mil
// filas: los máximos y las caídas los calcula la base (`EquityAggregates`).
//
// La curva tiene más puntos que los que mira el motor (uno por minuto contra uno por
// ciclo y por cierre): el pico repetido puede quedar un poco más alto que el del motor,
// un corte apenas más estricto.

import type { Settings } from '@sereno/shared'

export interface SettingsVersion {
  version: number
  at: number
  settings: Settings
}

// Agregados de la curva de capital de la sesión, en ventanas [from, to).
export interface EquityAggregates {
  peak(from: number, to: number): Promise<number | null>
  // Si algún punto cae `maxDrawdown` o más desde el pico corrido, que arranca en `priorPeak`.
  drawdownHit(from: number, to: number, priorPeak: number | null, maxDrawdown: number): Promise<boolean>
}

interface Segment {
  from: number
  to: number
  maxDrawdown: number
}

// `versions` desde el inicio de la sesión (la primera rige desde el inicio); la curva, en
// [startedAt, end).
export async function drawdownPeak(startedAt: number, end: number, versions: readonly SettingsVersion[], curve: EquityAggregates): Promise<number | null> {
  const ordered = [...versions].sort((a, b) => a.version - b.version)
  if (ordered.length === 0) throw new Error('drawdownPeak: la sesión no tiene ajustes')
  // Cada versión rige para los puntos desde su instante hasta el de la siguiente.
  const segments: Segment[] = ordered.map((v, i) => ({
    from: i === 0 ? startedAt : v.at,
    to: ordered[i + 1]?.at ?? end,
    maxDrawdown: v.settings.risk.maxDrawdown,
  }))

  // Desde dónde se mide el pico vigente.
  let anchor = startedAt
  for (let i = 1; i < ordered.length; i++) {
    const resumed = ordered[i - 1]!.settings.pause.paused && !ordered[i]!.settings.pause.paused
    if (resumed && (await drawdownBetween(curve, segments, anchor, ordered[i]!.at))) anchor = ordered[i]!.at
  }
  return curve.peak(anchor, end)
}

// Si en [from, to) la curva cayó el máximo vigente desde el pico medido desde `from`.
async function drawdownBetween(curve: EquityAggregates, segments: readonly Segment[], from: number, to: number): Promise<boolean> {
  for (const segment of segments) {
    const start = Math.max(from, segment.from)
    const stop = Math.min(to, segment.to)
    if (start >= stop) continue
    const prior = start > from ? await curve.peak(from, start) : null
    if (await curve.drawdownHit(start, stop, prior, segment.maxDrawdown)) return true
  }
  return false
}
