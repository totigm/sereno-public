import type { Composite, Side, SignalId } from '../types'
import { capitalize } from './format'

// Diccionario de razones de apertura: para cada señal, la frase que explica por qué
// acompaña a un long o a un short. Es una tabla única para que la UI pueda reusarla
// (por ejemplo, en la hoja de detalle de una posición). Fragmentos en minúscula y sin
// punto: `reasonSentence` los capitaliza y los une.
export const REASON_PHRASES: Record<SignalId, Record<Side, string>> = {
  trend15m: { long: 'la tendencia de 15 minutos es alcista', short: 'la tendencia de 15 minutos es bajista' },
  trendHigher: { long: 'la tendencia en 1h y 4h acompaña', short: 'la tendencia en 1h y 4h acompaña' },
  momentum: { long: 'el momentum empuja para arriba', short: 'el momentum empuja para abajo' },
  breakout: { long: 'rompió el máximo de las últimas 20 velas', short: 'rompió el mínimo de las últimas 20 velas' },
  // Media-reversión: cerca de la banda inferior favorece al long.
  bands: { long: 'el precio está cerca de la banda inferior', short: 'el precio está cerca de la banda superior' },
  vwap: { long: 'el precio está arriba del VWAP, que viene subiendo', short: 'el precio está abajo del VWAP, que viene bajando' },
  // Contrarian: el funding negativo favorece al long y el positivo al short.
  funding: { long: 'el funding está negativo', short: 'el funding está positivo' },
  openInterest: { long: 'el interés abierto acompaña la suba', short: 'el interés abierto acompaña la baja' },
  // Contrarian: demasiada gente del otro lado.
  positioning: { long: 'hay demasiada gente en short', short: 'hay demasiada gente en long' },
  btcRegime: { long: 'BTC está en tendencia alcista', short: 'BTC está en tendencia bajista' },
}

// Nombres de las señales para leerlas en castellano (diario de aprendizaje, tablas).
export const SIGNAL_NAMES: Record<SignalId, string> = {
  trend15m: 'la tendencia de 15 minutos',
  trendHigher: 'la tendencia mayor',
  momentum: 'el momentum',
  breakout: 'la ruptura',
  bands: 'las bandas',
  vwap: 'el VWAP',
  funding: 'el funding',
  openInterest: 'el interés abierto',
  positioning: 'el posicionamiento',
  btcRegime: 'el régimen de BTC',
}

const MAX_REASONS = 2
const FALLBACK_SENTENCE = 'Las señales en conjunto dieron para entrar.'

// Las dos señales de mayor |valor × peso efectivo| que votaron en el sentido del trade.
// Con peso cero la señal no aportó al compuesto, así que no cuenta como razón.
// El orden ante empates es el del compuesto (sort estable), para que la frase sea
// determinista entre corridas y replays.
export function pickReasons(c: Composite, side: Side): SignalId[] {
  const direction = side === 'long' ? 1 : -1
  const inFavor: { id: SignalId; strength: number }[] = []
  for (const s of c.signals) {
    if (s.value === null || s.value * direction <= 0) continue
    const strength = Math.abs(s.value * c.weights[s.id])
    if (strength > 0) inFavor.push({ id: s.id, strength })
  }
  return inFavor
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_REASONS)
    .map((s) => s.id)
}

export function reasonSentence(reasons: readonly SignalId[], side: Side): string {
  if (reasons.length === 0) return FALLBACK_SENTENCE
  return `${capitalize(reasons.map((id) => REASON_PHRASES[id][side]).join(' y '))}.`
}
