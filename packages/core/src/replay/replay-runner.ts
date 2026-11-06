import type { Settings } from '@sereno/shared'
import { compareShadow } from '../learning/shadow'
import { computeStats } from '../stats/stats'
import { PHASE_OFFSET } from './candle-player'
import { CANDLE_MS, DAY_MS, isParamTuningSlot, utcDay } from './clock'
import { Coverage } from './coverage'
import { createLane } from './lane'
import { ReplayMarket } from './market'
import { EquityRecorder, ReplayRecorder } from './recorder'
import { CalibrationReport } from './report'
import { perViewScorer } from './scoring'
import { simulate } from './simulation'
import type { ReplayInput, ReplayResult } from './types'
import { applyWeeklyReliability, ReliabilityWindow } from './weekly-reliability'
import { tuneWeekly } from './weekly-tuning'

// Replay determinista (spec §9): el mismo motor que en vivo, con reloj simulado, sobre el
// mercado histórico; cartera aprendida y sombra por separado. Mismo input ⇒ mismo
// resultado (y mismo JSON): sin reloj real, sin azar y con órdenes estables.

export async function runReplay(input: ReplayInput): Promise<ReplayResult> {
  const days = assertInput(input)
  const market = new ReplayMarket(input)
  const settings = withoutPause(input.settings)
  const idPrefix = `replay-${input.id}`
  const scorer = input.scorer ?? perViewScorer()
  const calibration = new CalibrationReport()
  const coverage = new Coverage(days, (symbol, t) => market.markFallback(symbol, t))
  const reliability = input.reliability ? new ReliabilityWindow() : null
  const recorder = new ReplayRecorder({
    keepDecisions: input.keepDecisions ?? true,
    onDecision: (decision) => {
      calibration.add(decision)
      coverage.add(decision)
      reliability?.add(decision)
    },
  })
  const emit = input.sink
  const lane = createLane({
    infos: input.infos,
    settings,
    learning: input.learningInit,
    capital: input.capital,
    start: input.from,
    idPrefix,
    shadow: true,
    scorer,
    sink: (event) => {
      recorder.event(event)
      emit(event)
    },
    onFailure: (failure) => recorder.failure(failure),
  })
  const equity = new EquityRecorder()
  equity.close(input.from, lane.engine.snapshot())
  let daysDone = 0
  let oppositeSideCandles = 0

  await simulate(market, [lane], { from: input.from, to: input.to }, {
    // El mismo turno semanal que el bot: primero la fiabilidad (pesos), después el ajuste de
    // parámetros, que simula con los pesos ya actualizados.
    beforeSlot: async (slot) => {
      if (!isParamTuningSlot(slot)) return
      if (reliability) await applyWeeklyReliability({ market, lane, window: reliability, settings, emit }, slot)
      if (!input.paramTuning) return
      await tuneWeekly(
        {
          market,
          lane,
          settings,
          capital: input.capital,
          replayFrom: input.from,
          ...(input.paramGrid ? { grid: input.paramGrid } : {}),
          scorer,
          idPrefix,
          emit,
          onFailure: (failure, tuning) => recorder.failure(failure, tuning),
        },
        slot,
      )
    },
    afterPhase: (slot, phase) => {
      if (phase === 'adverse') equity.adverse(slot + PHASE_OFFSET.adverse, lane.engine.snapshot())
    },
    opposed: () => {
      oppositeSideCandles += 1
    },
    afterSlot: async (slot) => {
      equity.close(slot + CANDLE_MS - 1, lane.engine.snapshot())
      const next = slot + CANDLE_MS
      if (next >= input.to || utcDay(next) !== utcDay(slot)) await input.progress?.({ day: ++daysDone, of: days.length })
    },
  })

  const final = lane.engine.snapshot()
  const { closed, decisions, failures } = recorder
  const curve = (book: 'real' | 'shadow') => equity.curve.map((p) => ({ at: p.at, equity: p[book].equity }))
  return {
    closed,
    open: { real: final.real.positions.map((s) => s.position), shadow: final.shadow?.positions.map((s) => s.position) ?? [] },
    equity: equity.curve,
    decisions,
    stats: { real: computeStats(closed.real, equity.worstCase('real')), shadow: computeStats(closed.shadow, equity.worstCase('shadow')) },
    shadowComparison: compareShadow(
      { equity: curve('real'), trades: closed.real },
      { equity: curve('shadow'), trades: closed.shadow },
      input.capital,
      (input.to - input.from) / DAY_MS,
      input.to,
    ),
    learningFinal: final.learning,
    signalHistogram: calibration.histogram(),
    correlation: calibration.correlation(),
    missingSignalWindows: coverage.missingSignalWindows(),
    missingMarkWindows: coverage.missingMarkWindows(),
    universeByDay: coverage.universeByDay(),
    caveats: { drawdownPause: recorder.drawdownPause, shadowOppositeSideCandles: oppositeSideCandles },
    failures,
  }
}

// La pausa es del bot en vivo (Toti la pone y la saca): un replay simula el período entero.
// La pausa por drawdown máximo es del motor y no se levanta: queda en `caveats`.
function withoutPause(settings: Settings): Settings {
  return { ...settings, pause: { paused: false, by: null, at: null, reason: null } }
}

// Valida el período y el universo; devuelve los días UTC simulados, en orden.
function assertInput(input: ReplayInput): string[] {
  if (input.id.length === 0) throw new RangeError('el replay necesita un id')
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.from >= input.to) {
    throw new RangeError(`período inválido: [${input.from}, ${input.to})`)
  }
  if (input.from % CANDLE_MS !== 0 || input.to % CANDLE_MS !== 0) throw new RangeError('el período tiene que empezar y terminar en el borde de una vela de 15m')
  const days: string[] = []
  for (let slot = input.from; slot < input.to; slot += CANDLE_MS) {
    const day = utcDay(slot)
    if (days.at(-1) === day) continue
    if (!input.symbolsByDay[day]) throw new RangeError(`sin universo para el día ${day}`)
    days.push(day)
  }
  return days
}
