// Comandos del dashboard (spec §10): cada 3 s se marcan vencidos los sensibles al precio
// que nadie tomó a tiempo y se reclaman los pendientes de a uno (claim atómico). Un
// comando termina recién cuando lo que produjo quedó guardado; si falla, queda `failed`
// con el motivo para el dashboard.

import { coinName } from '@sereno/core/src/journal/coin-name'
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { CommandResult, CommandRow, RealEventInput, Repos } from '@sereno/db'
import { COMMAND_TTL_MS, CommandSchema, type Command, type Settings } from '@sereno/shared'
import { errorMessage } from '../jobs/errors'
import type { Logger } from '../logger'
import type { RealKit } from '../real/kit'
import type { EngineLane } from './engine-lane'
import { liftAutoPause } from './pause'

// Tope por pasada: una cola larga no frena el resto del bucle.
export const MAX_COMMANDS_PER_TICK = 10

export interface ReplayHooks {
  // Un replay quedó en cola (`en_cola`): el worker de replays lo toma.
  onReplayQueued?: (replaySessionId: string) => void
  onReplayCancelled?: (replaySessionId: string) => void
}

export interface CommandDeps {
  sessionId: string
  instanceId: string
  repos: Repos
  now: () => number
  lane: EngineLane
  settings: () => Settings
  // Antigüedad de la última marca del símbolo; null si nunca llegó una.
  markAge: (symbol: string) => number | null
  hooks: ReplayHooks
  logger: Logger
  // Sólo en la sesión real.
  real?: RealCommandDeps
}

export interface RealCommandDeps {
  kit: Pick<RealKit, 'exchange'>
  // Deja de abrir en el acto, antes de cerrar (el estado de la base y `entry` llegan con el lote).
  switchOff: (entry: RealEventInput) => void
  // Va a los errores de la sesión (el dashboard los muestra).
  recordError: (message: string, error: unknown) => void
}

export async function processCommands(deps: CommandDeps): Promise<void> {
  const { repos, sessionId, instanceId, logger } = deps
  const expired = await repos.commands.expireStale(sessionId)
  if (expired > 0) logger.warn({ expired }, 'Comandos vencidos sin ejecutar')
  for (let i = 0; i < MAX_COMMANDS_PER_TICK; i++) {
    const row = await repos.commands.claimNext(sessionId, instanceId)
    if (!row) return
    const outcome = await execute(deps, row).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    if (outcome instanceof Error) logger.error({ command: row.kind, id: row.id, err: outcome.message }, 'Falló un comando')
    await repos.commands.finish(row.id, outcome)
  }
}

function parse(row: CommandRow): Command | null {
  const parsed = CommandSchema.safeParse({ id: row.id, sessionId: row.sessionId, requestedBy: row.requestedBy, kind: row.kind, payload: row.payload })
  return parsed.success ? parsed.data : null
}

async function execute(deps: CommandDeps, row: CommandRow): Promise<CommandResult> {
  const command = parse(row)
  if (!command) return { ok: false, message: 'El comando no tiene la forma esperada.' }
  switch (command.kind) {
    case 'close_position':
      return closePosition(deps, command.payload.symbol)
    case 'close_all':
      return closeAll(deps)
    case 'release_protected':
      return releaseProtected(deps)
    case 'reset_learning':
      return resetLearning(deps)
    case 'run_replay':
      return runReplay(deps, command.payload)
    case 'cancel_replay':
      return cancelReplay(deps, command.payload.replaySessionId)
    case 'real_off':
      return deps.real ? realOff(deps, deps.real) : { ok: false, message: 'Esta simulación no opera con plata real.' }
  }
}

// Nunca se cierra a un precio viejo: sin una marca del último minuto, el comando falla.
function staleMark(deps: CommandDeps, symbol: string): CommandResult | null {
  const age = deps.markAge(symbol)
  if (age !== null && age <= COMMAND_TTL_MS) return null
  return { ok: false, message: `No tengo un precio actual de ${coinName(symbol)}: no cierro a ciegas.` }
}

async function closePosition(deps: CommandDeps, symbol: string): Promise<CommandResult> {
  if (!deps.lane.snapshot().real.positions.some((s) => s.position.symbol === symbol)) {
    return { ok: false, message: `No había una posición abierta en ${coinName(symbol)}.` }
  }
  const stale = staleMark(deps, symbol)
  if (stale) return stale
  // Se atrapa sólo la falla del cierre; si falla guardarlo, ese sigue siendo el error del comando.
  const outcome = await deps.lane.run((engine) =>
    engine.closePosition(symbol, 'manual').then(
      (closed) => ({ closed }),
      (error: unknown) => ({ error }),
    ),
  )
  // Un cierre pedido no se reintenta solo: lo que quedó abierto lo vuelve a pedir Toti.
  if ('error' in outcome) return { ok: false, message: `No pude cerrar ${coinName(symbol)}: ${errorMessage(outcome.error)}. Si querés cerrar lo que quedó, pedilo de nuevo.` }
  const { closed } = outcome
  if (!closed) return { ok: false, message: `No había una posición abierta en ${coinName(symbol)}.` }
  return { ok: true, message: `Cerré ${coinName(symbol)}.`, data: { positionId: closed.id, pnlNet: closed.pnlNet } }
}

async function closeAll(deps: CommandDeps): Promise<CommandResult> {
  const open = deps.lane.snapshot().real.positions.map((s) => s.position.symbol)
  for (const symbol of open) {
    const stale = staleMark(deps, symbol)
    if (stale) return stale
  }
  const closed = await deps.lane.run((engine) => engine.closeAll('close_all'))
  const left = deps.lane.snapshot().real.positions.length
  const message = closed.length === 1 ? 'Cerré 1 posición.' : `Cerré ${closed.length} posiciones.`
  if (left === 0) return { ok: true, message, data: { closed: closed.map((c) => c.id) } }
  // Como un cierre pedido, nada lo reintenta solo.
  const unclosed = left === 1 ? '1 no se pudo cerrar; si querés cerrarla' : `${left} no se pudieron cerrar; si querés cerrarlas`
  return { ok: false, message: `${message} ${unclosed}, pedilo de nuevo.` }
}

// El interruptor de la sesión real: cierra todo a mercado sin mirar la edad de la marca (Binance
// cierra a su precio) y, en el mismo lote que esos cierres, la deja apagada. Los algos del bot
// se cancelan sólo si no quedó nada abierto: una que no se pudo cerrar conserva su stop.
async function realOff(deps: CommandDeps, real: RealCommandDeps): Promise<CommandResult> {
  const { sessionId } = deps
  const total = deps.lane.snapshot().real.positions.length
  const entry: RealEventInput = { at: deps.now(), kind: 'off', symbol: null, phrase: 'Apagaste la operación con plata real: cerré lo que tenía abierto.' }
  real.switchOff(entry)
  let uncancelled = false
  const closed = await deps.lane.run(
    async (engine) => {
      const done = await engine.closeAll('close_all')
      if (engine.snapshot().real.positions.length === 0) {
        await real.kit.exchange.cancelAllBot().catch((error: unknown) => {
          uncancelled = true
          real.recordError('No pude cancelar los stops del bot al apagar', error)
        })
      }
      return done
    },
    () => async (repos) => {
      await repos.sessions.setRealStatus(sessionId, 'off', 'user')
      await repos.realEvents.append(sessionId, [entry])
    },
  )
  if (closed.length === total) {
    // Los que quedan sin posición del bot los cancela la reconciliación en su próxima vuelta.
    const leftover = uncancelled ? ' No pude cancelar los stops del bot que quedaron: los cancelo en la próxima revisión.' : ''
    return { ok: true, message: `Cerré todo y apagué la operación con plata real.${leftover}`, data: { closed: closed.map((c) => c.id) } }
  }
  return { ok: false, message: `Cerré ${closed.length} de ${total}; las demás las reintento con el próximo precio. La operación quedó apagada.` }
}

// Volver a usar el capital blindado. Si la pausa automática era por falta de margen con
// el capital blindado (no por drawdown), ya no tiene motivo: se levanta en la misma transacción.
async function releaseProtected(deps: CommandDeps): Promise<CommandResult> {
  const result = await deps.lane.run(
    (engine) => engine.releaseProtected(),
    (r) => {
      const { pause } = deps.settings()
      if (!r.released || !pause.paused || pause.by !== 'auto' || deps.lane.snapshot().real.guard.drawdownPaused) return undefined
      return async (repos) => {
        await liftAutoPause(repos, deps.sessionId)
      }
    },
  )
  if (result.released) return { ok: true, message: 'Volví a usar el capital blindado.' }
  return { ok: false, message: result.reason === 'not_shielded' ? 'No había capital blindado.' : 'No queda saldo para volver a usar.' }
}

async function resetLearning(deps: CommandDeps): Promise<CommandResult> {
  const at = deps.now()
  await deps.lane.run(
    (engine) => engine.applyLearning(initialLearningState(at)),
    () => async (repos) => {
      await repos.learning.appendLog(deps.sessionId, {
        at,
        kind: 'reset',
        symbol: null,
        signal: null,
        message: 'Volví a empezar a aprender: pesos, confianza y parámetros vuelven a los valores iniciales.',
        sampleSize: 0,
        before: null,
        after: null,
      })
    },
  )
  return { ok: true, message: 'Reinicié el aprendizaje.' }
}

async function runReplay(deps: CommandDeps, payload: Extract<Command, { kind: 'run_replay' }>['payload']): Promise<CommandResult> {
  const row = await deps.repos.sessions.createReplay({
    name: `Replay de ${payload.days} días`,
    capitalInicial: payload.capital,
    settings: deps.settings(),
    learningOrigin: payload.learningOrigin === 'zero' ? 'zero' : 'continued',
    replayParams: payload,
  })
  deps.hooks.onReplayQueued?.(row.id)
  return { ok: true, message: 'Dejé el replay en cola.', data: { replaySessionId: row.id } }
}

async function cancelReplay(deps: CommandDeps, replaySessionId: string): Promise<CommandResult> {
  const row = await deps.repos.sessions.get(replaySessionId)
  if (!row || row.kind !== 'replay') return { ok: false, message: 'No encontré ese replay.' }
  const cancelled = await deps.repos.sessions.updateProgress(replaySessionId, { status: 'cancelado', progreso: row.progreso ?? 0, mensaje: 'Cancelado a pedido tuyo.' })
  if (!cancelled) return { ok: false, message: 'Ese replay ya había terminado.' }
  deps.hooks.onReplayCancelled?.(replaySessionId)
  return { ok: true, message: 'Cancelé el replay.' }
}
