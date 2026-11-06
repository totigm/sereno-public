import { SIGNAL_IDS, type Composite, type SignalId, type SignalResult } from '@sereno/core'
import { adxModifier, volumeModifier } from '@sereno/core/src/signals/modifiers'
import type { Rng } from './random'

// Compuestos inventados pero con la aritmética de spec §5.3: S es la media ponderada
// de las señales con dato (pesos 1 mientras el aprendizaje junta datos) y
// S′ = clamp(S × mADX × mVol, −1, 1). Las señales se sortean alrededor del S pedido y
// después se corrigen para que su media dé exactamente ese S.

export interface CompositeInput {
  // S′ buscado; el S sale de dividir por los modificadores.
  sPrime: number
  missing: readonly SignalId[]
  adx: number
  relVolume: number
  higherTrendAgainst: 0 | 1 | 2
  // El régimen de BTC es el mismo para todas las monedas en un ciclo.
  btcRegime: number
}

const SPREAD = 0.4
const DECIMALS = 1000

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const round = (x: number): number => Math.round(x * DECIMALS) / DECIMALS

export function syntheticComposite(rng: Rng, input: CompositeInput): Composite {
  const mAdx = adxModifier(input.adx)
  const mVol = volumeModifier(input.relVolume)
  const target = clamp(input.sPrime / (mAdx * mVol), -1, 1)
  const present = SIGNAL_IDS.filter((id) => !input.missing.includes(id))
  const free = present.filter((id) => id !== 'btcRegime')
  const values = new Map<SignalId, number>()
  for (const id of present) values.set(id, id === 'btcRegime' ? round(input.btcRegime) : clamp(target + SPREAD * rng.normal(), -1, 1))
  // Unas pasadas de corrección alcanzan: el recorte en ±1 es lo único que la frena.
  for (let pass = 0; pass < 6 && free.length > 0; pass++) {
    const sum = present.reduce((acc, id) => acc + (values.get(id) ?? 0), 0)
    const shift = (target * present.length - sum) / free.length
    for (const id of free) values.set(id, round(clamp((values.get(id) ?? 0) + shift, -1, 1)))
  }
  const signals: SignalResult[] = SIGNAL_IDS.map((id) => ({ id, value: values.get(id) ?? null }))
  const S = present.length === 0 ? 0 : present.reduce((acc, id) => acc + (values.get(id) ?? 0), 0) / present.length
  return {
    S,
    Sprime: clamp(S * mAdx * mVol, -1, 1),
    confidence: Math.abs(S),
    signals,
    missing: SIGNAL_IDS.filter((id) => !values.has(id)),
    weights: Object.fromEntries(SIGNAL_IDS.map((id) => [id, 1])) as Record<SignalId, number>,
    modifiers: { adx: mAdx, vol: mVol },
    relVolume: input.relVolume,
    higherTrendAgainst: input.higherTrendAgainst,
  }
}
