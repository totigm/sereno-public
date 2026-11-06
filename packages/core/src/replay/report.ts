import { SIGNAL_IDS, type Decision, type SignalResult } from '../types'
import type { HistogramBin, SignalCorrelation } from './types'

// Lo que el reporte del replay trae para calibrar θ con datos y no a ojo (spec §5.3): el
// histograma de S′ y la correlación entre señales. Se arma decisión por decisión, así el
// replay no necesita guardarlas todas. Cuentan sólo las decisiones con la vela del ciclo:
// sin ella, S′ es el de una vista vieja.

// Barras de 0,05 entre −1 y +1, alineadas con la grilla de θ (spec §8.3).
const BINS_PER_UNIT = 20
const BIN_COUNT = 2 * BINS_PER_UNIT
// S′ se lleva a millonésimas antes de elegir la barra: 0,35 cae en la que empieza en 0,35
// aunque en coma flotante 1,35 × 20 quede apenas por debajo de 27.
const MICROS = 1_000_000
const MICROS_PER_BIN = MICROS / BINS_PER_UNIT

// Co-momentos de un par de señales, acumulados en una pasada (Welford): con cientos de
// miles de decisiones la fórmula de sumas de cuadrados perdería precisión.
interface PairMoments {
  n: number
  meanX: number
  meanY: number
  m2x: number
  m2y: number
  cxy: number
}

export class CalibrationReport {
  private readonly counts = new Array<number>(BIN_COUNT).fill(0)
  private readonly moments: PairMoments[][] = SIGNAL_IDS.map(() => SIGNAL_IDS.map(() => ({ n: 0, meanX: 0, meanY: 0, m2x: 0, m2y: 0, cxy: 0 })))

  add(decision: Decision): void {
    if (decision.action.kind === 'blocked' && decision.action.reason === 'no_candle') return
    this.count(decision.composite.Sprime)
    this.correlate(decision.composite.signals)
  }

  histogram(): HistogramBin[] {
    return this.counts.map((count, i) => ({ from: (i - BINS_PER_UNIT) / BINS_PER_UNIT, to: (i + 1 - BINS_PER_UNIT) / BINS_PER_UNIT, count }))
  }

  correlation(): SignalCorrelation {
    const at = (i: number, j: number): PairMoments => this.moments[Math.min(i, j)]![Math.max(i, j)]!
    return {
      signals: [...SIGNAL_IDS],
      rho: SIGNAL_IDS.map((_, i) => SIGNAL_IDS.map((__, j) => pearson(at(i, j), i === j))),
      pairs: SIGNAL_IDS.map((_, i) => SIGNAL_IDS.map((__, j) => at(i, j).n)),
    }
  }

  private count(Sprime: number): void {
    if (!Number.isFinite(Sprime)) return
    const micros = Math.round((Sprime + 1) * MICROS)
    const index = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(micros / MICROS_PER_BIN)))
    this.counts[index] = (this.counts[index] ?? 0) + 1
  }

  private correlate(signals: readonly SignalResult[]): void {
    const values = SIGNAL_IDS.map((id) => {
      const value = signals.find((s) => s.id === id)?.value
      return value !== null && value !== undefined && Number.isFinite(value) ? value : null
    })
    for (let i = 0; i < values.length; i++) {
      const x = values[i]
      if (x === null || x === undefined) continue
      for (let j = i; j < values.length; j++) {
        const y = values[j]
        if (y !== null && y !== undefined) accumulate(this.moments[i]![j]!, x, y)
      }
    }
  }
}

function accumulate(m: PairMoments, x: number, y: number): void {
  m.n += 1
  const dx = x - m.meanX
  m.meanX += dx / m.n
  const dy = y - m.meanY
  m.meanY += dy / m.n
  m.m2x += dx * (x - m.meanX)
  m.m2y += dy * (y - m.meanY)
  m.cxy += dx * (y - m.meanY)
}

// Una señal consigo misma correlaciona 1 si varía; se fija en vez de dejar el 0,999… del cociente.
function pearson(m: PairMoments, diagonal: boolean): number | null {
  if (m.n < 2 || m.m2x <= 0 || m.m2y <= 0) return null
  if (diagonal) return 1
  return m.cxy / Math.sqrt(m.m2x * m.m2y)
}
