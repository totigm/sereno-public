// Persistencia de lo que hace el motor (spec §10). Cada lote (los eventos de una operación
// del motor más el estado que dejó) va en una sola transacción y en el orden en que pasó:
// decisiones, altas y cierres de posiciones con sus eventos, aprendizaje y la pausa
// automática de un drawdown, todo junto o nada. Después sincroniza las abiertas (stop,
// trailing, funding), el blindaje, el estado de aprendizaje y la curva de capital.
//
// Los lotes se escriben de a uno y en orden. Uno que falla no se pierde: queda en la cola
// y se reintenta antes del siguiente. Mientras esperan, sólo el último conserva el estado
// del motor (sincronizar con él deja la base igual que sincronizar con todos), así una
// base caída durante horas no acumula un snapshot por lote. Si la base responde y rechaza
// el mismo lote tres veces, ese lote se descarta y se avisa: uno roto no frena al resto.
// Si la sesión se archivó, nada se escribe y avisa.
//
// Un lote descartado con cierres dejaría esas posiciones abiertas en la base para siempre
// (el dashboard las mostraría abiertas y un reinicio las volvería a abrir en el motor, con
// un margen que ya no existe): `sync` sólo escribe las abiertas del snapshot. Los cierres
// del lote descartado se guardan aparte y se vuelven a escribir solos, cada uno en su
// transacción, después de cada lote que sí entra. Si la base tampoco acepta el cierre
// solo, se deja de intentar y se avisa qué posición quedó abierta.

import type { AccountSnapshot, EngineEvent } from '@sereno/core'
import type { EngineSnapshot } from '@sereno/core/src/engine/types'
import { createRepos, SessionArchivedError, type Db, type EquityPoint, type Repos } from '@sereno/db'
import type { EquitySnapshotKind } from '@sereno/shared'
import { closeEvent, fundingEvent, learningEntry, openEvent, stopMovedEvent } from './payloads'
import { setAutoPause } from './pause'

export const MAX_REJECTIONS = 3

export interface PersistBatch {
  events: readonly EngineEvent[]
  snapshot: EngineSnapshot
  // Cierre de la vela del ciclo: la latencia de las entradas se mide desde ahí.
  cycleT?: number
  // Punto de la curva por minuto (además del de evento, si hubo eventos).
  minute?: boolean
  // Escrituras de un comando que tienen que ir en la misma transacción.
  extra?: (repos: Repos) => Promise<void>
}

export interface PersisterDeps {
  db: Pick<Db, 'transaction'>
  sessionId: string
  // Un lote que la base rechazó `MAX_REJECTIONS` veces quedó afuera.
  onDiscard: (error: unknown) => void
  // Un cierre de un lote descartado que la base tampoco aceptó solo: la posición sigue
  // abierta en la base y el motor ya la cerró. Sin esto, avisa por `onDiscard`.
  onStuckOpen?: (positionId: string, error: unknown) => void
  // La sesión real: el funding que guarda es el que cobró Binance.
  fundingReported?: boolean
}

type ClosedEvent = Extract<EngineEvent, { type: 'position_closed' }>

interface UnwrittenClose {
  event: ClosedEvent
  rejections: number
}

// Eventos que mueven la curva de capital: cada uno deja un punto `event`.
const EQUITY_EVENTS: ReadonlySet<EngineEvent['type']> = new Set(['position_opened', 'position_closed', 'funding_applied', 'account_rule'])

// Errores de conexión o de concurrencia: la base no rechazó el lote, se reintenta sin contar.
const TRANSIENT_CODE = /^(08|53|57P0[1-3]|40001|40P01|E(CONNRESET|CONNREFUSED|PIPE|TIMEDOUT))/

interface Pending {
  events: readonly EngineEvent[]
  cycleT: number | undefined
  extra: PersistBatch['extra']
  points: EquityPoint[]
  snapshot: EngineSnapshot | null
  rejections: number
}

interface Written {
  open: Map<string, string>
  shield: string | null
  learningVersion: number | null
}

class Rejected extends Error {
  constructor(readonly reason: unknown) {
    super('La base rechazó el lote')
  }
}

export class Persister {
  private chain: Promise<void> = Promise.resolve()
  private queue: Pending[] = []
  private inFlight: Pending | null = null
  private archived = false
  private written: Written = { open: new Map(), shield: null, learningVersion: null }
  // Cierres de lotes descartados que todavía no están en la base, por id de posición.
  private unwrittenCloses = new Map<string, UnwrittenClose>()

  constructor(private readonly deps: PersisterDeps) {}

  get sessionId(): string {
    return this.deps.sessionId
  }

  // Resuelve cuando el lote quedó escrito (con los pendientes de antes); rechaza si no.
  write(batch: PersistBatch): Promise<void> {
    const last = this.queue.at(-1)
    if (last && last !== this.inFlight) last.snapshot = null
    const pending: Pending = {
      events: batch.events,
      cycleT: batch.cycleT,
      extra: batch.extra,
      points: equityPoints(batch),
      snapshot: batch.snapshot,
      rejections: 0,
    }
    this.queue.push(pending)
    const run = this.chain.then(() => this.flush(pending))
    this.chain = run.catch(() => undefined)
    return run
  }

  // Espera a que termine lo encolado.
  async idle(): Promise<void> {
    await this.chain
  }

  get pendingRetries(): number {
    return this.queue.length
  }

  // Cierres de lotes descartados que esperan volver a escribirse.
  get pendingCloses(): number {
    return this.unwrittenCloses.size
  }

  // Escribe la cola hasta `target` inclusive. El que se descarta nunca es `target`: cada
  // lote se intenta por primera vez en su propia escritura y las siguientes veces en las
  // de los que esperan detrás.
  private async flush(target: Pending): Promise<void> {
    while (this.queue.includes(target)) {
      const head = this.queue[0]!
      try {
        await this.commit(head)
        this.queue.shift()
        await this.writeUnwrittenCloses()
      } catch (error) {
        if (error instanceof SessionArchivedError) {
          this.archived = true
          this.queue = []
          throw error
        }
        if (!(error instanceof Rejected)) throw error
        head.rejections += 1
        if (head.rejections < MAX_REJECTIONS) throw error.reason
        this.queue.shift()
        for (const event of head.events) {
          if (event.type === 'position_closed') this.unwrittenCloses.set(event.position.id, { event, rejections: 0 })
        }
        this.deps.onDiscard(error.reason)
      }
    }
  }

  // Los cierres de los lotes descartados, cada uno solo. Nunca tira: un cierre que no
  // entra no frena el lote que acaba de escribirse ni los siguientes.
  private async writeUnwrittenCloses(): Promise<void> {
    const { sessionId } = this.deps
    for (const [id, pending] of [...this.unwrittenCloses]) {
      try {
        await this.deps.db.transaction(async (tx) => {
          const repos = createRepos(tx)
          // `close` no pisa una fila ya cerrada: el evento sólo va si el cierre se escribió.
          if (await repos.positions.close(sessionId, pending.event.position, pending.event.phrase)) {
            await repos.positions.addEvent(id, closeEvent(pending.event))
          }
        })
        this.unwrittenCloses.delete(id)
        this.written.open.delete(id)
      } catch (error) {
        if (error instanceof SessionArchivedError) {
          this.unwrittenCloses.clear()
          return
        }
        if (isTransient(error)) return
        pending.rejections += 1
        if (pending.rejections < MAX_REJECTIONS) continue
        this.unwrittenCloses.delete(id)
        if (this.deps.onStuckOpen) this.deps.onStuckOpen(id, error)
        else this.deps.onDiscard(error)
      }
    }
  }

  private async commit(pending: Pending): Promise<void> {
    if (this.archived) throw new SessionArchivedError(this.deps.sessionId)
    const next: Written = { open: new Map(this.written.open), shield: this.written.shield, learningVersion: this.written.learningVersion }
    let reached = false
    this.inFlight = pending
    try {
      await this.deps.db.transaction(async (tx) => {
        const repos = createRepos(tx)
        const session = await repos.sessions.get(this.deps.sessionId)
        if (!session || session.status === 'archived') throw new SessionArchivedError(this.deps.sessionId)
        reached = true
        await this.apply(repos, pending, next)
      })
    } catch (error) {
      if (reached && !(error instanceof SessionArchivedError) && !isTransient(error)) throw new Rejected(error)
      throw error
    } finally {
      this.inFlight = null
    }
    this.written = next
  }

  private async apply(repos: Repos, pending: Pending, written: Written): Promise<void> {
    const { sessionId } = this.deps
    for (const event of pending.events) await this.applyEvent(repos, event, pending, written)
    if (pending.snapshot) await this.sync(repos, pending.snapshot, pending.events, written)
    if (pending.points.length > 0) await repos.equity.insert(sessionId, pending.points)
    await pending.extra?.(repos)
  }

  // El estado que dejó el motor: abiertas que cambiaron, blindaje y aprendizaje.
  private async sync(repos: Repos, snapshot: EngineSnapshot, events: readonly EngineEvent[], written: Written): Promise<void> {
    const { sessionId } = this.deps
    const open = [...snapshot.real.positions, ...(snapshot.shadow?.positions ?? [])].map((s) => s.position)
    for (const position of open) {
      const json = JSON.stringify(position)
      if (written.open.get(position.id) === json) continue
      await repos.positions.upsertOpen(sessionId, position)
      written.open.set(position.id, json)
    }

    const { protegido, baseBlindaje } = snapshot.accounts.real
    const shield = `${protegido}:${baseBlindaje}`
    if (written.shield !== shield) {
      await repos.sessions.updateShield(sessionId, { protegido, baseBlindaje })
      written.shield = shield
    }
    if (written.learningVersion !== snapshot.learning.version || events.some((e) => e.type === 'learning_updated')) {
      await repos.learning.save(sessionId, snapshot.learning)
      written.learningVersion = snapshot.learning.version
    }
  }

  private async applyEvent(repos: Repos, event: EngineEvent, pending: Pending, written: Written): Promise<void> {
    const { sessionId } = this.deps
    switch (event.type) {
      case 'decisions':
        if (event.decisions.length > 0) await repos.decisions.insertBatch(sessionId, event.decisions)
        return
      case 'position_opened': {
        const latencyMs = pending.cycleT === undefined ? null : Math.max(0, event.position.openedAt - pending.cycleT)
        await repos.positions.upsertOpen(sessionId, event.position, { latencyMs })
        await repos.positions.addEvent(event.position.id, openEvent(event))
        written.open.set(event.position.id, JSON.stringify(event.position))
        return
      }
      case 'position_closed':
        await repos.positions.close(sessionId, event.position, event.phrase)
        await repos.positions.addEvent(event.position.id, closeEvent(event))
        written.open.delete(event.position.id)
        return
      case 'stop_moved':
        await repos.positions.addEvent(event.positionId, stopMovedEvent(event))
        return
      case 'funding_applied':
        await repos.positions.addEvent(event.positionId, fundingEvent(event, this.deps.fundingReported))
        return
      case 'learning_updated':
        await repos.learning.appendLog(sessionId, learningEntry(event))
        return
      case 'account_rule':
        // Sólo lo real pausa la sesión; el drawdown de la sombra queda en el log.
        if (!event.shadow && (event.rule === 'drawdown' || event.rule === 'shield_insufficient')) {
          await setAutoPause(repos, sessionId, event.phrase, event.at)
        }
        return
      case 'waited':
        // El diario arma los "esperé" desde `decisions`.
        return
    }
  }
}

// Los puntos de la curva del lote, calculados al recibirlo: el snapshot se puede soltar
// antes de escribirlo.
function equityPoints(batch: PersistBatch): EquityPoint[] {
  const points: EquityPoint[] = []
  if (batch.events.some((e) => EQUITY_EVENTS.has(e.type))) points.push(...equityPoint(batch.snapshot, 'event'))
  if (batch.minute) points.push(...equityPoint(batch.snapshot, 'minute'))
  return points
}

function isTransient(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_CODE.test(code)) return true
  }
  return false
}

export function equityPoint(snapshot: EngineSnapshot, kind: EquitySnapshotKind): EquityPoint[] {
  return equityRow(snapshot.at, snapshot.accounts.real, snapshot.accounts.shadow, kind)
}

// El punto de la curva con las cuentas real y sombra en `at` (también el de cada vela de un
// replay). Sin la marca de alguna abierta el equity no es exacto: ese punto no se escribe
// (la curva mostraría un salto que no pasó y el pico del drawdown se mediría mal al reiniciar).
export function equityRow(at: number, real: AccountSnapshot, shadow: AccountSnapshot | null, kind: EquitySnapshotKind): EquityPoint[] {
  if (real.marksIncomplete) return []
  return [
    {
      at,
      saldo: real.saldo,
      equity: real.equity,
      margenEnUso: real.margenEnUso,
      protegido: real.protegido,
      capitalBase: real.capitalBase,
      capitalOperable: real.capitalOperable,
      shadowEquity: shadow && !shadow.marksIncomplete ? shadow.equity : null,
      kind,
    },
  ]
}
