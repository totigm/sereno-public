// Lee de la base lo que necesita `planRestore` para retomar una sesión.

import type { ClosedPosition, Position } from '@sereno/core'
import type { OpenPositionState } from '@sereno/core/src/engine/types'
import type { BotFlags, PositionRecord, Repos, SessionRow } from '@sereno/db'
import { startOfDayBA, type Settings } from '@sereno/shared'
import { drawdownPeak, type EquityAggregates } from './drawdown-peak'
import { entryCostsOf } from './payloads'
import type { RealizedAt, RestoreInput } from './restore'

// Toda la historia de ajustes: son pocas filas por sesión (una por cada vez que se guardan).
const ALL_VERSIONS = Number.MAX_SAFE_INTEGER

export interface RestoreSource {
  session: SessionRow
  // Los ajustes con que se retoma y su versión: las posteriores las aplica el runtime.
  settings: Settings
  settingsVersion: number
  // Los cortes del último latido guardado, leídos antes de escribir uno nuevo.
  lastFlags: BotFlags | null
  tickSize: (symbol: string) => number
  now: number
}

export async function loadRestoreInput(repos: Repos, source: RestoreSource): Promise<RestoreInput> {
  const { session, settings, settingsVersion, now } = source
  const id = session.id
  const startedAt = session.startedAt.getTime()
  const [realOpen, shadowOpen, realClosed, shadowClosed, history] = await Promise.all([
    repos.positions.listOpen(id),
    repos.positions.listOpen(id, { shadow: true }),
    repos.positions.listClosed(id),
    repos.positions.listClosed(id, { shadow: true }),
    repos.settings.history(id, ALL_VERSIONS),
  ])
  const open = await Promise.all(
    [...realOpen, ...shadowOpen].map(async (record): Promise<OpenPositionState> => {
      const opened = (await repos.positions.listEvents(record.id)).find((e) => e.kind === 'open')
      return { position: positionOf(record), entryCosts: entryCostsOf(opened?.payload ?? {}), tickSize: source.tickSize(record.symbol) }
    }),
  )
  const versions = history.filter((h) => h.version <= settingsVersion).map((h) => ({ version: h.version, at: h.changedAt.getTime(), settings: h.config }))
  // La curva no se trae: el pico sale de agregados que calcula la base.
  const curve: EquityAggregates = {
    peak: (from, to) => repos.equity.peak(id, from, to),
    drawdownHit: (from, to, priorPeak, maxDrawdown) => repos.equity.drawdownHit(id, { from, to, priorPeak, maxDrawdown }),
  }
  const equityPeak = await drawdownPeak(startedAt, now + 1, versions.length > 0 ? versions : [{ version: settingsVersion, at: startedAt, settings }], curve)
  const closed = [...realClosed.items, ...shadowClosed.items].map((c): ClosedPosition => c)
  return {
    session: { capitalInicial: session.capitalInicial, protegido: session.protegido, baseBlindaje: session.baseBlindaje, startedAt },
    settings,
    open,
    closed,
    lastFlags: source.lastFlags,
    equityPeak,
    closedCosts: await closedCostsOf(repos, closed),
  }
}

// La comisión de entrada (evento `open`) y los funding de los cerrados que abrieron otro
// día (de Buenos Aires) que el del cierre: en los demás todo cae el mismo día y no cambia
// la pérdida diaria. Son pocos (los que pasaron una medianoche abiertos).
async function closedCostsOf(repos: Repos, closed: readonly ClosedPosition[]): Promise<Map<string, RealizedAt[]>> {
  const overnight = closed.filter((c) => startOfDayBA(c.openedAt) !== startOfDayBA(c.closedAt))
  const entries = await Promise.all(
    overnight.map(async (c): Promise<[string, RealizedAt[]]> => {
      const costs: RealizedAt[] = []
      for (const e of await repos.positions.listEvents(c.id)) {
        const at = e.at.getTime()
        const amount = numberIn(e.payload, e.kind === 'open' ? 'fee' : 'amount')
        // El evento `funding` guarda lo pagado (positivo); como resultado es negativo.
        if ((e.kind === 'open' || e.kind === 'funding') && amount !== null && amount !== 0) costs.push({ at, amount: -amount })
      }
      return [c.id, costs]
    }),
  )
  return new Map(entries)
}

function numberIn(payload: unknown, key: string): number | null {
  const v = (payload as Record<string, unknown> | null)?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// La posición tal como la conoce el motor, sin lo que agrega la base.
export function positionOf(record: PositionRecord): Position {
  const { sessionId: _session, missingSignals: _missing, latencyMs: _latency, ...position } = record
  return position
}
