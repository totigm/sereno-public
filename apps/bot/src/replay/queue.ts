// La cola de replays del proceso (spec §9): uno a la vez y los demás `en_cola` en el orden
// en que se pidieron. Quién corre cada uno lo dice un lease en `bot_lease` (el mismo de las
// sesiones en vivo), así se distingue un replay que corre en otro proceso (la línea de
// comandos) de uno que quedó huérfano.
//
// Al reiniciar, un replay que había quedado a medias se marca fallido en vez de retomarse:
// si fue él quien tumbó el proceso (memoria), retomarlo lo volvería a tumbar en cada
// arranque; sus filas parciales (días ya guardados) y su aprendizaje no se pueden empalmar
// con una corrida nueva sin rehacer la simulación desde el principio; y volver a pedirlo
// es un toque en el dashboard que reutiliza las velas ya bajadas.

import type { Repos } from '@sereno/db'
import { errorMessage } from '../jobs/errors'
import type { Logger } from '../logger'
import { replayFailureMessage } from './failure'
import type { ReplayOutcome } from './run'
import type { WorkerRun } from './worker'

export const REPLAY_POLL_MS = 10_000
export const REPLAY_LEASE_TTL_MS = 30_000
// Un huérfano no siempre viene de un reinicio del bot: también puede ser la línea de comandos
// que se cerró, un proceso colgado cuyo lease venció o uno que no pudo anotar su final.
export const ORPHAN_MESSAGE = 'Se cortó antes de terminar: el proceso que lo corría se detuvo. Pedilo de nuevo.'
export const SHUTDOWN_MESSAGE = 'Se interrumpió al apagar el bot: pedilo de nuevo.'

export interface ReplayQueueDeps {
  repos: Pick<Repos, 'sessions' | 'bot'>
  instanceId: string
  // Arranca el replay en un worker.
  start: (sessionId: string) => WorkerRun<ReplayOutcome>
  logger: Logger
  pollMs?: number
}

interface Running {
  sessionId: string
  run: WorkerRun<ReplayOutcome>
  finished: Promise<void>
  // Su lease venció y lo tomó otro proceso: la sesión y el lease ya son de ese otro.
  lost: boolean
}

export class ReplayQueue {
  private running: Running | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking: Promise<void> | null = null
  private again = false
  private stopped = false

  constructor(private readonly deps: ReplayQueueDeps) {}

  start(): void {
    this.wake()
  }

  // Revisa la cola ya (un replay recién pedido no espera al próximo sondeo).
  wake(): void {
    if (this.stopped) return
    if (this.ticking) {
      this.again = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ticking = this.tick()
      .catch((error: unknown) => this.deps.logger.error({ err: errorMessage(error) }, 'Cola de replays: falló la revisión'))
      .finally(() => {
        this.ticking = null
        if (this.again) {
          this.again = false
          this.wake()
        } else if (!this.stopped) {
          this.timer = setTimeout(() => this.wake(), this.deps.pollMs ?? REPLAY_POLL_MS)
        }
      })
  }

  // Al apagar: corta el replay en curso (queda fallido) y suelta su lease.
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.ticking
    const running = this.running
    if (!running) return
    await running.run.terminate()
    await running.finished
  }

  private async tick(): Promise<void> {
    const { repos, instanceId } = this.deps
    const running = this.running
    if (running && !running.lost && !(await repos.bot.acquireLease(running.sessionId, instanceId, REPLAY_LEASE_TTL_MS))) {
      // El lease venció (el proceso estuvo colgado o sin base más de 30 s) y otro proceso lo
      // tomó: ese otro ya lo dio por cortado, así que acá se deja de correr.
      this.deps.logger.warn({ sessionId: running.sessionId }, 'Replay: otro proceso tomó su lease, lo corto')
      running.lost = true
      await running.run.terminate()
    }
    let busy = this.running !== null
    for (const row of await repos.sessions.listReplays(['descargando', 'simulando'])) {
      if (row.id === this.running?.sessionId) continue
      // Si su lease se puede tomar, nadie lo está corriendo: quedó a medias.
      if (await repos.bot.acquireLease(row.id, instanceId, REPLAY_LEASE_TTL_MS)) {
        await repos.sessions.updateProgress(row.id, { status: 'fallido', progreso: row.progreso ?? 0, mensaje: ORPHAN_MESSAGE })
        await repos.bot.releaseLease(row.id, instanceId)
        this.deps.logger.warn({ sessionId: row.id }, 'Replay huérfano marcado fallido')
      } else {
        busy = true
      }
    }
    if (busy || this.stopped) return
    const [next] = await repos.sessions.listReplays(['en_cola'])
    // Si otro proceso lo tiene (la línea de comandos que lo acaba de crear), se espera.
    if (next && (await repos.bot.acquireLease(next.id, instanceId, REPLAY_LEASE_TTL_MS))) this.launch(next.id)
  }

  private launch(sessionId: string): void {
    this.deps.logger.info({ sessionId }, 'Replay: arranca')
    const running: Running = { sessionId, run: this.deps.start(sessionId), finished: Promise.resolve(), lost: false }
    running.finished = this.settle(running).finally(() => {
      this.running = null
      this.wake()
    })
    this.running = running
  }

  // Cuando el worker termina. El replay escribe su propio final; si el worker terminó sin
  // resultado (se cayó o lo cortaron), queda fallido acá. Después suelta el lease.
  private async settle(running: Running): Promise<void> {
    const { logger, repos, instanceId } = this.deps
    const { sessionId } = running
    try {
      const outcome = await running.run.result
      logger.info({ sessionId, outcome }, 'Replay: terminó')
    } catch (error) {
      if (running.lost) return
      logger.error({ sessionId, err: errorMessage(error) }, 'Replay: el worker terminó sin resultado')
      try {
        const progreso = (await repos.sessions.get(sessionId))?.progreso ?? 0
        const mensaje = this.stopped ? SHUTDOWN_MESSAGE : replayFailureMessage(error)
        await repos.sessions.updateProgress(sessionId, { status: 'fallido', progreso, mensaje })
      } catch (writeError) {
        // Sin el lease, la próxima revisión lo encuentra a medias y lo marca huérfano.
        logger.error({ sessionId, err: errorMessage(writeError) }, 'Replay: no pude marcarlo fallido')
      }
    }
    await repos.bot.releaseLease(sessionId, instanceId).catch((error: unknown) => logger.error({ sessionId, err: errorMessage(error) }, 'Replay: no pude soltar su lease'))
  }
}
