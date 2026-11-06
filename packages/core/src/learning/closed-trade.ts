import type { ClosedPosition, LearningState } from '../types'
import { updateConfidence } from './confidence'
import type { LearningChange, LearningSettings } from './state'
import { updateWeightsFromTrade } from './weights'

// Punto de entrada único al cerrar un trade: pesos (que cuentan `closedTrades`) y
// confianza (que cuenta `tradesBySymbol`, la `n` del encogimiento) tienen que
// correr siempre juntos, o el peso efectivo por moneda se calcula con una `n`
// que no corresponde. Cada paso respeta el congelamiento por su cuenta. Un trade
// de la sombra devuelve el estado tal cual y sin log: hay un solo `LearningState`
// por sesión, el de la cartera real, y la sombra decide con pesos congelados y
// lleva su propia penitencia en el motor, sin `mMoneda` (spec §8, "Sombra").
export function learnFromClosedTrade(
  state: LearningState,
  closed: ClosedPosition,
  learning: LearningSettings,
  now: number,
): { state: LearningState; log: LearningChange[] } {
  if (closed.shadow) return { state, log: [] }
  const weights = updateWeightsFromTrade(state, closed, learning, now)
  const confidence = updateConfidence(weights.state, closed, learning, now)
  return { state: confidence.state, log: [...weights.log, ...confidence.log] }
}
