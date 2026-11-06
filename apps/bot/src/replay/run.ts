// Corre un replay pedido (spec §9): descarga, simulación con el `runReplay` del core y lo
// que deja en la base (posiciones, decisiones, curva, aprendizaje final, el universo de cada
// día en `universe_days` y el reporte en `sessions.report`), con el avance en `sessions`
// ("Descargando velas · 12 de 30 monedas", "Simulando · día 41 de 90"). Cancelar es marcar
// `cancelado` en la base: cada escritura del avance lo detecta y el replay se corta a más
// tardar al terminar el día que estaba simulando.

import type { Decision } from '@sereno/core'
import type { Scorer } from '@sereno/core/src/engine/types'
import type { PackedCandles } from '@sereno/core/src/replay/packed-candles'
import type { ReplayData } from '@sereno/core/src/replay/types'
import { runReplay } from '@sereno/core/src/replay/replay-runner'
import { createRepos, type Db, type ForwardReturns, type SessionsRepo } from '@sereno/db'
import type { ReplayStatus } from '@sereno/shared'
import type { CallBudget } from '../jobs/budget'
import { errorMessage } from '../jobs/errors'
import { forwardReturnsAt } from '../jobs/forward-returns'
import type { Logger } from '../logger'
import { downloadReplayData, type DownloadStep, type ReplayRest } from './download'
import { replayFailureMessage } from './failure'
import { replayLearning } from './learning-init'
import { replayPeriod } from './period'
import { buildReport } from './report'
import { replayUniverseDays } from './universe-days'
import { ReplayWriter } from './writer'

export interface RunDeps {
  db: Db
  rest: ReplayRest
  budget: CallBudget
  logger: Logger
  now: () => number
  // Por defecto el puntaje compuesto real; los tests fijan uno.
  scorer?: Scorer
}

export type ReplayOutcome = 'listo' | 'cancelado' | 'fallido'

// Lo cancelaron (o ya había terminado) mientras corría.
class ReplayCancelled extends Error {
  constructor() {
    super('El replay se canceló')
  }
}

// Tramos de la barra: universo, monedas y simulación. El 1 llega con el `listo`.
const UNIVERSE_END = 0.05
const DOWNLOAD_END = 0.4
const SIMULATION_END = 0.98
// Escrituras del avance durante la descarga: a lo sumo una por segundo.
const PROGRESS_WRITE_MS = 1000

export async function runReplaySession(deps: RunDeps, sessionId: string): Promise<ReplayOutcome> {
  const { db, logger } = deps
  const repos = createRepos(db)
  const row = await repos.sessions.get(sessionId)
  if (!row || row.kind !== 'replay' || !row.replayParams) throw new Error(`${sessionId} no es un replay pedido`)
  const params = row.replayParams
  const progress = new Progress(repos.sessions, sessionId)
  try {
    await progress.set('descargando', 0, 'Preparando la descarga', true)
    const period = replayPeriod(params.days, deps.now())
    const settings = row.settingsSnapshot
    const learning = await replayLearning(repos, params.learningOrigin, period.from)
    // Pedido con el vigente y sin nada aprendido que continuar: arranca de cero, y la sesión
    // lo dice igual que el reporte.
    if (learning.origin.origin === 'zero' && row.learningOrigin !== 'zero') await repos.sessions.setReplayLearningOrigin(sessionId, 'zero')
    logger.info({ sessionId, days: params.days, from: period.from, to: period.to, learning: learning.origin.origin }, 'Replay: descargando')
    const { data, meta, selection } = await downloadReplayData(
      { rest: deps.rest, repos, budget: deps.budget, logger },
      { period, now: deps.now(), settings },
      (step) => progress.download(step),
      { compact: true },
    )
    await progress.set('simulando', DOWNLOAD_END, `Simulando · día 0 de ${params.days}`, true)
    const writer = new ReplayWriter({ db, sessionId, forward: forwardFrom(data) })
    const result = await runReplay({
      ...data,
      id: sessionId,
      settings,
      learningInit: learning.state,
      capital: row.capitalInicial,
      from: period.from,
      to: period.to,
      paramTuning: params.paramTuning,
      reliability: true,
      keepDecisions: false,
      ...(deps.scorer ? { scorer: deps.scorer } : {}),
      sink: writer.add,
      progress: async ({ day, of }) => {
        await writer.flush()
        await progress.set('simulando', DOWNLOAD_END + ((SIMULATION_END - DOWNLOAD_END) * day) / of, `Simulando · día ${day} de ${of}`, true)
      },
    })
    const report = buildReport({ result, period, capital: row.capitalInicial, paramTuning: params.paramTuning, learning: learning.origin, meta })
    const universeDays = replayUniverseDays({ ...selection, settings: settings.universe, symbolsByDay: data.symbolsByDay, evaluated: result.universeByDay })
    await writer.finish(result, async (tx) => {
      await tx.universeDays.upsertDays(sessionId, universeDays)
      const trades = report.stats.real.trades
      const done = await tx.sessions.completeReplay(sessionId, { report, mensaje: `Listo · ${trades} ${trades === 1 ? 'trade cerrado' : 'trades cerrados'}` })
      // Si lo cancelaron justo al final, no queda nada de lo último.
      if (!done) throw new ReplayCancelled()
    })
    logger.info({ sessionId, trades: report.stats.real.trades, roi: report.stats.real.roi }, 'Replay listo')
    return 'listo'
  } catch (error) {
    if (error instanceof ReplayCancelled) {
      logger.info({ sessionId }, 'Replay cancelado')
      return 'cancelado'
    }
    logger.error({ sessionId, err: errorMessage(error) }, 'El replay falló')
    await repos.sessions.updateProgress(sessionId, { status: 'fallido', progreso: progress.value, mensaje: replayFailureMessage(error) })
    return 'fallido'
  }
}

class Progress {
  value = 0
  private writtenAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly sessions: Pick<SessionsRepo, 'updateProgress'>,
    private readonly sessionId: string,
  ) {}

  // Sin `force`, sólo escribe si pasó un segundo desde la última vez.
  async set(status: ReplayStatus, progreso: number, mensaje: string, force = false): Promise<void> {
    this.value = progreso
    if (!force && Date.now() - this.writtenAt < PROGRESS_WRITE_MS) return
    this.writtenAt = Date.now()
    if (!(await this.sessions.updateProgress(this.sessionId, { status, progreso, mensaje }))) throw new ReplayCancelled()
  }

  download({ stage, done, total }: DownloadStep): Promise<void> {
    const last = done === total
    if (stage === 'universe') return this.set('descargando', (UNIVERSE_END * done) / total, `Eligiendo el universo · ${done} de ${total} monedas`, last)
    return this.set('descargando', UNIVERSE_END + ((DOWNLOAD_END - UNIVERSE_END) * done) / total, `Descargando velas · ${done} de ${total} monedas`, last)
  }
}

// Los retornos a 4 h y 24 h de cada decisión con las velas de 15m que ya bajó el replay (las
// compactadas alcanzan: una decisión lee la vela que la disparó y las siguientes).
function forwardFrom(data: ReplayData<PackedCandles>): (decision: Decision) => ForwardReturns {
  const none = (): undefined => undefined
  return (decision) => {
    const candles = data.candles[decision.symbol]?.['15m'].last
    return forwardReturnsAt(candles ? (openTime) => closeAt(candles, openTime) : none, decision.t)
  }
}

// El cierre de la vela cerrada de 15m que abre en `openTime`, si está (como `closesByOpen`).
function closeAt(candles: PackedCandles, openTime: number): number | undefined {
  const i = candles.indexOf(openTime)
  return i >= 0 && candles.closed[i] === 1 ? candles.close[i] : undefined
}
