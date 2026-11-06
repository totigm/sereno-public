// Con qué aprendizaje arranca un replay (spec §9): de cero, o con lo que aprendió la
// simulación en vivo al momento de correrlo, llevado al inicio del período.

import type { LearningState } from '@sereno/core'
import { initialLearningState, signalRecord, weekStartOf } from '@sereno/core/src/learning/state'
import type { Repos, ReplayReport } from '@sereno/db'

export interface ReplayLearning {
  state: LearningState
  origin: ReplayReport['learning']
}

export async function replayLearning(repos: Pick<Repos, 'sessions' | 'learning'>, requested: 'zero' | 'current', from: number): Promise<ReplayLearning> {
  const live = requested === 'current' ? await repos.sessions.getActive('paper_live') : null
  const current = live ? await repos.learning.get(live.id) : null
  // Sin simulación en vivo (o sin nada aprendido todavía) no hay qué continuar: el
  // reporte dice que arrancó de cero.
  if (!live || !current) return { state: initialLearningState(from), origin: { origin: 'zero', fromSessionId: null } }
  return { state: rebased(current, from), origin: { origin: 'continued', fromSessionId: live.id } }
}

// Pesos, confianza y parámetros siguen; lo que está fechado en el tiempo del vivo no: el
// tope semanal arranca la semana del inicio, las penitencias (que vencen días después de
// hoy) no bloquean monedas todo el período y los parámetros cuentan desde `from`.
function rebased(state: LearningState, from: number): LearningState {
  return { ...state, weekStart: weekStartOf(from), weeklyDelta: signalRecord(0), penalties: {}, params: { ...state.params, since: from } }
}
