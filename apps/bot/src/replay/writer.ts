// Lo que produce un replay, guardado de a un día: el motor emite eventos sin esperar (el
// `sink` es síncrono) y el replay se detiene al terminar cada día hasta que el lote quedó
// escrito en una transacción. Así un replay de 90 días no junta en memoria cientos de
// miles de decisiones ni las cruza enteras del worker al proceso principal.

import type { Decision, EngineEvent } from '@sereno/core'
import type { ReplayResult } from '@sereno/core/src/replay/types'
import { createRepos, type Db, type ForwardReturns, type Repos } from '@sereno/db'
import { closeEvent, fundingEvent, learningEntry, openEvent, stopMovedEvent } from '../live/payloads'
import { equityRow } from '../live/persist'

export interface WriterDeps {
  db: Pick<Db, 'transaction'>
  sessionId: string
  // Retornos a 4 h y 24 h de cada decisión, con las velas que el replay ya tiene.
  forward: (decision: Decision) => ForwardReturns
}

export class ReplayWriter {
  private events: EngineEvent[] = []

  constructor(private readonly deps: WriterDeps) {}

  readonly add = (event: EngineEvent): void => {
    // La pausa por drawdown queda en el reporte (`caveats`) y los "esperé" salen de las decisiones.
    if (event.type !== 'account_rule' && event.type !== 'waited') this.events.push(event)
  }

  async flush(): Promise<void> {
    if (this.events.length === 0) return
    await this.deps.db.transaction((tx) => this.write(createRepos(tx)))
  }

  // Lo que queda del último día y el estado final: abiertas, curva de capital, aprendizaje
  // y blindaje. `last` escribe en la misma transacción (el universo de cada día, el reporte
  // y el `listo`).
  async finish(result: ReplayResult, last: (repos: Repos) => Promise<void>): Promise<void> {
    const { sessionId } = this.deps
    await this.deps.db.transaction(async (tx) => {
      const repos = createRepos(tx)
      await this.write(repos)
      for (const position of [...result.open.real, ...result.open.shadow]) await repos.positions.upsertOpen(sessionId, position)
      // Un punto por vela.
      await repos.equity.insert(sessionId, result.equity.flatMap(({ at, real, shadow }) => equityRow(at, real, shadow, 'minute')))
      await repos.learning.save(sessionId, result.learningFinal)
      const real = result.equity.at(-1)?.real
      if (real) await repos.sessions.updateShield(sessionId, { protegido: real.protegido, baseBlindaje: real.baseBlindaje })
      await last(repos)
    })
  }

  private async write(repos: Repos): Promise<void> {
    const { sessionId, forward } = this.deps
    const events = this.events.splice(0)
    const decisions = events.flatMap((e) => (e.type === 'decisions' ? e.decisions : []))
    if (decisions.length > 0) await repos.decisions.insertBatch(sessionId, decisions, forward)
    for (const event of events) {
      switch (event.type) {
        case 'position_opened':
          await repos.positions.upsertOpen(sessionId, event.position)
          await repos.positions.addEvent(event.position.id, openEvent(event))
          break
        case 'position_closed':
          await repos.positions.close(sessionId, event.position, event.phrase)
          await repos.positions.addEvent(event.position.id, closeEvent(event))
          break
        case 'stop_moved':
          await repos.positions.addEvent(event.positionId, stopMovedEvent(event))
          break
        case 'funding_applied':
          await repos.positions.addEvent(event.positionId, fundingEvent(event))
          break
        case 'learning_updated':
          await repos.learning.appendLog(sessionId, learningEntry(event))
          break
      }
    }
  }
}
