// Lo que la sesión real agrega al `LiveSession` (spec de plata real): reconciliar con
// Binance antes de retomar, el gating (si abre, sólo cuida o nada), el tope de pérdida, lo
// fatal y el diario de `real_events`. El gating se recalcula cada 3 s con el estado de la
// sesión en la base y la última revisión de la cuenta. Un apagado de este proceso (`real_off`,
// lo fatal, el tope de pérdida) manda sobre lo que se lee hasta que la base lo tenga: si su
// lote no se guardó, la lectura siguiente no vuelve a abrir y el apagado se guarda de nuevo,
// con su entrada del diario. Se guarda por el carril del motor, detrás del lote original: el
// persistidor escribe en orden, así que si ese lote entra primero la entrada no se repite.
// Si la base cambió de estado desde el apagado (el lote entró y Toti la volvió a prender),
// manda la base; se vuelve a mirar al escribir, no sólo al leer. El tope de pérdida no:
// la base no deja salir de él, así que guardado a tiempo habría quedado igual.

import type { EngineEvent } from '@sereno/core'
import type { FundingApplied } from '@sereno/core/src/exchange/types'
import type { RealEventInput, Repos, SessionRow } from '@sereno/db'
import type { BinanceEnv, RealGate, RealOffReason, RealStatus } from '@sereno/shared'
import type { BotConfig } from '../config'
import { errorMessage } from '../jobs/errors'
import type { RealCommandDeps } from '../live/commands'
import type { EngineLane, ExtraWrite } from '../live/engine-lane'
import type { RecentErrors } from '../live/heartbeat'
import type { SessionExtension } from '../live/session'
import type { RestoreContext } from '../live/session-load'
import type { Clock } from '../live/timers'
import type { Logger } from '../logger'
import type { OpeningsGate, RealNote } from './exchange'
import { decideGate } from './gate'
import type { RealKit } from './kit'
import type { ReadinessWriter } from './readiness'

export interface RealControllerDeps {
  repos: Repos
  sessionId: string
  binanceEnv: BinanceEnv
  realStatus: RealStatus
  // Cuándo cambió de estado en la base (ms), al leer la sesión.
  realChangedAt: number | null
  kit: RealKit
  lane: EngineLane
  clock: Clock
  logger: Logger
  config: RealGateConfig
  readiness: Pick<ReadinessWriter, 'latest' | 'run'>
  errors: RecentErrors
}

export type RealGateConfig = Pick<BotConfig['real'], 'enabled' | 'env'>

// Lo único de la configuración que decide el gating: una copia sin las claves, así un log de
// lo que recibe el controlador nunca las puede llevar.
export function gateConfig(real: RealGateConfig): RealGateConfig {
  return { enabled: real.enabled, env: real.env }
}

// Un apagado de este proceso que la base todavía no tiene.
interface UnsavedOff {
  status: Exclude<RealStatus, 'on'>
  reason: RealOffReason | null
  // La entrada del diario que iba en el mismo lote.
  entry: RealEventInput | null
  // `realChangedAt` de la base al apagar.
  baseline: number | null
}

export class RealController implements SessionExtension {
  private realStatus: RealStatus
  private changedAt: number | null
  private current: RealGate
  private journal: Promise<void> = Promise.resolve()
  private fatal = false
  private stopped = false
  // Apagada por este proceso y todavía `on` en la base.
  private unsaved: UnsavedOff | null = null
  // Apagada con `real_off` y con abiertas que todavía no se pudieron cerrar.
  private closingAll = false

  constructor(private readonly deps: RealControllerDeps) {
    this.realStatus = deps.realStatus
    this.changedAt = deps.realChangedAt
    this.current = this.decide()
  }

  gate(): RealGate {
    return this.current
  }

  commands(): RealCommandDeps {
    return { kit: this.deps.kit, switchOff: (entry) => this.switchOff(entry), recordError: (message, error) => this.recordError(message, error) }
  }

  // Lo que consulta el adaptador antes de abrir.
  openings(): OpeningsGate {
    const { mode, missing } = this.current
    return mode === 'trading' ? { allowed: true } : { allowed: false, detail: `falta ${missing.join(', ')}` }
  }

  // Cada nota del adaptador y de la reconciliación va al diario; una fatal además apaga.
  note(note: RealNote): void {
    this.record([{ at: this.deps.clock.now(), kind: note.kind, symbol: note.symbol, phrase: note.phrase, ...(note.data ? { data: note.data } : {}) }])
    if (note.kind === 'fatal') this.shutDown(note)
  }

  async beforeRestore(ctx: RestoreContext): Promise<void> {
    const result = await this.deps.kit.reconcileAtStart(ctx)
    this.record(result.notes.map((note) => ({ at: ctx.now, kind: note.kind, symbol: note.symbol, phrase: note.phrase, ...(note.data ? { data: note.data } : {}) })))
    await this.journal
  }

  async started(): Promise<void> {
    const { kit, repos, sessionId, clock } = this.deps
    kit.watch(await fundingSince(repos, sessionId, clock.now()), (applied) => this.funded(applied))
    await this.deps.readiness.run().catch((error: unknown) => this.recordError('No pude revisar la cuenta de Binance', error))
    this.current = this.decide()
  }

  // Lo que pide `real_off` (con la entrada del diario de su lote): deja de abrir ya; lo que no
  // pudo cerrar se reintenta en cada vuelta.
  switchOff(entry: RealEventInput): void {
    this.turnOff('off', 'user', entry)
    this.closingAll = true
  }

  async poll(): Promise<void> {
    const row = await this.deps.repos.sessions.get(this.deps.sessionId)
    const stored = row?.realStatus ?? null
    const changedAt = row?.realChangedAt?.getTime() ?? null
    if (this.unsaved !== null && needsSave(this.unsaved, row)) {
      await this.saveOff(this.unsaved)
    } else if (stored !== null) {
      this.changedAt = changedAt
      this.unsaved = null
      // Toti la volvió a prender: un fatal nuevo la vuelve a apagar.
      if (stored === 'on' && this.realStatus !== 'on') this.fatal = false
      this.realStatus = stored
    }
    this.current = this.decide()
    // Toti la volvió a prender: lo que quedó abierto sigue operándose normalmente.
    if (this.realStatus === 'on') this.closingAll = false
    if (this.closingAll) await this.retryCloseAll()
  }

  // El tope de pérdida: el motor ya cerró lo que pudo; acá se cancela todo algo del bot que
  // quede y, en el mismo lote que esos cierres, la sesión queda apagada por el tope.
  async afterOp(events: readonly EngineEvent[]): Promise<ExtraWrite | undefined> {
    const floor = events.find((e): e is Extract<EngineEvent, { type: 'account_rule' }> => e.type === 'account_rule' && e.rule === 'loss_floor' && e.shadow !== true)
    if (!floor || this.realStatus === 'loss_floor') return undefined
    const entry: RealEventInput = { at: floor.at, kind: 'loss_floor', symbol: null, phrase: floor.phrase }
    this.turnOff('loss_floor', null, entry)
    // Una que no se pudo cerrar conserva su stop: el motor la vuelve a cerrar con el próximo precio.
    if (this.deps.lane.snapshot().real.positions.length === 0) {
      await this.deps.kit.exchange.cancelAllBot().catch((error: unknown) => this.recordError('No pude cancelar los stops del bot al tocar el tope', error))
    }
    const { sessionId } = this.deps
    return async (repos) => {
      await repos.sessions.setRealStatus(sessionId, 'loss_floor', null)
      await repos.realEvents.append(sessionId, [entry])
    }
  }

  stop(): void {
    this.stopped = true
  }

  // Binance dejó de aceptar a la sesión (clave, IP, modo de la cuenta): se cierra lo que se
  // pueda y queda apagada. Sigue viva en sólo reducir: las abiertas que no se pudieron cerrar
  // conservan su stop en Binance. No se reintenta solo: con la clave rechazada cada intento
  // sería otro rechazo; prenderla de nuevo (o `real_off`) es decisión de Toti.
  private shutDown(note: RealNote): void {
    if (this.fatal || this.stopped) return
    this.fatal = true
    this.turnOff('off', 'fatal', null)
    const { lane, sessionId, logger } = this.deps
    logger.error({ sessionId, phrase: note.phrase }, 'Error fatal de Binance: apago la operación con plata real')
    lane
      .run(
        (engine) => engine.closeAll('close_all'),
        () => async (repos) => {
          await repos.sessions.setRealStatus(sessionId, 'off', 'fatal')
        },
      )
      .catch((error: unknown) => this.recordError('No pude cerrar todo después del error fatal', error))
  }

  private turnOff(status: UnsavedOff['status'], reason: RealOffReason | null, entry: RealEventInput | null): void {
    this.realStatus = status
    this.unsaved = { status, reason, entry, baseline: this.changedAt }
    this.current = this.decide()
  }

  // El estado que no llegó a la base con su lote, y su entrada del diario si el lote no la
  // escribió. La lectura siguiente confirma que quedó.
  private async saveOff(off: UnsavedOff): Promise<void> {
    if (this.stopped) return
    const { lane, sessionId } = this.deps
    await lane
      .run(
        async () => undefined,
        () => async (repos) => {
          if (needsSave(off, await repos.sessions.get(sessionId))) await repos.sessions.setRealStatus(sessionId, off.status, off.reason)
          if (off.entry && !(await journaled(repos, sessionId, off.entry))) await repos.realEvents.append(sessionId, [off.entry])
        },
      )
      .catch((error: unknown) => this.recordError('No pude guardar que la operación real quedó apagada; lo reintento', error))
  }

  private async retryCloseAll(): Promise<void> {
    const { lane } = this.deps
    if (lane.snapshot().real.positions.length === 0) {
      this.closingAll = false
      return
    }
    const closed = await lane.run((engine) => engine.closeAll('close_all'))
    if (lane.snapshot().real.positions.length > 0) return
    this.closingAll = false
    if (closed.length > 0) await this.deps.kit.exchange.cancelAllBot().catch((error: unknown) => this.recordError('No pude cancelar los stops del bot al apagar', error))
  }

  // El funding cobrado llega al motor por su moneda (el adaptador entrega lo encolado).
  private funded(applied: readonly FundingApplied[]): void {
    const last = new Map(applied.map((f) => [f.symbol, f]))
    for (const f of last.values()) {
      this.deps.lane
        .run((engine) => engine.onFunding({ symbol: f.symbol, at: f.at, rate: f.rate, markPrice: f.markPrice }))
        .catch((error: unknown) => this.recordError(`No pude anotar el funding de ${f.symbol}`, error))
    }
  }

  private decide(): RealGate {
    const { config, readiness, binanceEnv } = this.deps
    return decideGate({ enabled: config.enabled, keysPresent: true, env: config.env, checks: readiness.latest, session: { realStatus: this.realStatus, binanceEnv } })
  }

  // De a uno y en orden: el diario cuenta lo que pasó como pasó.
  private record(events: RealEventInput[]): void {
    if (events.length === 0) return
    const { repos, sessionId } = this.deps
    this.journal = this.journal.then(() => repos.realEvents.append(sessionId, events)).catch((error: unknown) => this.recordError('No pude guardar en el diario de la operación real', error))
  }

  private recordError(message: string, error: unknown): void {
    this.deps.logger.error({ sessionId: this.deps.sessionId, err: errorMessage(error) }, message)
    this.deps.errors.push(this.deps.clock.now(), `${message}: ${errorMessage(error)}`)
  }
}

// ¿La base todavía no tiene el apagado y nada lo deshizo? Un tope de pérdida guardado no se
// pisa (la base no lo deja); un apagado se guarda sólo si la base no cambió de estado desde
// entonces.
function needsSave(off: UnsavedOff, row: Pick<SessionRow, 'realStatus' | 'realChangedAt'> | null | undefined): boolean {
  if (!row || row.realStatus === off.status || row.realStatus === 'loss_floor') return false
  return off.status === 'loss_floor' || (row.realChangedAt?.getTime() ?? null) === off.baseline
}

async function journaled(repos: Repos, sessionId: string, entry: RealEventInput): Promise<boolean> {
  const same = await repos.realEvents.list(sessionId, { from: entry.at, to: entry.at + 1 })
  return same.some((e) => e.kind === entry.kind && e.phrase === entry.phrase)
}

// Desde cuándo pedir el funding a Binance: lo último que quedó guardado. Con varias abiertas
// manda la más reciente: Binance cobra a todas en los mismos horarios, y contar dos veces un
// cobro ya guardado es peor que perder uno de mientras el bot no estaba.
async function fundingSince(repos: Repos, sessionId: string, now: number): Promise<number> {
  const open = await repos.positions.listOpen(sessionId)
  if (open.length === 0) return now
  let since = Number.NEGATIVE_INFINITY
  for (const position of open) {
    const funded = (await repos.positions.listEvents(position.id)).filter((e) => e.kind === 'funding')
    const last = funded.reduce((max, e) => Math.max(max, e.at.getTime()), Number.NEGATIVE_INFINITY)
    since = Math.max(since, Number.isFinite(last) ? last + 1 : position.openedAt)
  }
  return since
}
