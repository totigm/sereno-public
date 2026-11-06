import type { Settings } from '@sereno/shared'
import { learningUpdated } from '../engine/events'
import type { EngineFailure, Scorer } from '../engine/types'
import { applyWalkForward, paramTuningBlock, type ParamCombo, type WalkForwardResult } from '../learning/params'
import type { EngineEvent } from '../types'
import type { Lane } from './lane'
import type { ReplayMarket } from './market'
import { tuneParams, WALK_FORWARD_MS } from './param-tuning'
import { errorMessage } from './recorder'
import type { TuningRun } from './types'

// El ajuste semanal de parámetros dentro de un replay: lo que el job del bot hace los
// domingos a las 00:30 UTC, con la historia que el replay ya recorrió.

export interface WeeklyTuning {
  market: ReplayMarket
  lane: Lane
  settings: Settings
  capital: number
  // Inicio del replay: antes sólo hay calentamiento, no velas para simular.
  replayFrom: number
  grid?: readonly ParamCombo[]
  // El de la corrida principal: comparte con ella el cálculo de señales por vista.
  scorer: Scorer
  idPrefix: string
  emit: (event: EngineEvent) => void
  // Las fallas de las corridas del ajuste. No son las de la principal: abrir y cerrar
  // dependen de los parámetros de cada combinación. Llegan agrupadas por operación,
  // símbolo y mensaje, con la primera corrida donde pasaron y cuántas veces.
  onFailure: (failure: EngineFailure, tuning: { run: TuningRun; count: number }) => void
}

interface Repeated {
  failure: EngineFailure
  run: TuningRun
  count: number
}

export async function tuneWeekly(tuning: WeeklyTuning, now: number): Promise<void> {
  const { lane } = tuning
  const learning = lane.engine.snapshot().learning
  // Prender el ajuste del replay es la decisión de Toti para esta corrida: manda sobre el
  // `paramTuningEnabled` de los ajustes; el congelamiento, no.
  const settings = { ...tuning.settings.learning, paramTuningEnabled: true }
  if (paramTuningBlock(learning, settings) !== null) return
  // Una falla de datos (un funding inválido, una moneda sin precio) no depende de los
  // parámetros: pasaría igual en cada una de las hasta 136 combinaciones del domingo.
  const repeated = new Map<string, Repeated>()
  const note = (failure: EngineFailure, params: ParamCombo): void => {
    const key = JSON.stringify([failure.operation, failure.symbol, errorMessage(failure.error)])
    const seen = repeated.get(key)
    if (seen) seen.count += 1
    else repeated.set(key, { failure, run: { at: now, params }, count: 1 })
  }
  let result: WalkForwardResult
  try {
    result = await tuneParams({
      market: tuning.market,
      settings: tuning.settings,
      learning,
      capital: tuning.capital,
      from: Math.max(tuning.replayFrom, now - WALK_FORWARD_MS),
      to: now,
      ...(tuning.grid ? { grid: tuning.grid } : {}),
      scorer: tuning.scorer,
      idPrefix: `${tuning.idPrefix}-wf-${now}`,
      onFailure: note,
    })
  } finally {
    for (const { failure, run, count } of repeated.values()) tuning.onFailure(failure, { run, count })
  }
  const applied = applyWalkForward(learning, result, settings, now)
  if (applied.state !== learning) await lane.engine.applyLearning(applied.state)
  for (const change of applied.log) tuning.emit(learningUpdated(change))
}
