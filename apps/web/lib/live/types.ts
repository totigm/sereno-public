import type { BotError, BotFlags, CommandResult, MarketSymbolView, PositionRecord } from '@sereno/db'
import type { BotPhase, CommandKind, CommandStatus, EquitySnapshotKind, RealGate, RealStatus, Settings } from '@sereno/shared'

// Lo que devuelve `GET /api/live`: todo lo que cambia mientras la pantalla está
// abierta. Los instantes van en ms (como en el motor) para que el JSON y las props
// de los Server Components tengan la misma forma.

export interface MarketSnapshotView {
  /** `market_snapshot.version`: sube en cada escritura del bot. */
  version: number
  /** Cuándo escribió el bot los precios: la "hora del último snapshot" de los valores apagados sin conexión. */
  updatedAt: number
  symbols: MarketSymbolView[]
}

/** Valuación de una abierta a la marca vigente; todo null si la moneda no tiene precio. */
export interface PositionValuation {
  mark: number | null
  /** No realizado bruto: (marca − entrada) × cantidad, con el signo del lado. */
  unrealized: number | null
  /** No realizado menos lo ya pagado en comisiones y funding: lo que dejaría cerrarla ahora (sin la comisión de salida). */
  net: number | null
  /** R vigente neto: `net / riesgoReal` (spec §5.5). */
  r: number | null
  /** `net / margin`. */
  pctOfMargin: number | null
}

export type OpenPositionView = PositionRecord & { valuation: PositionValuation }

export interface BotStatusView {
  instanceId: string
  lastHeartbeat: number
  phase: BotPhase
  warmProgress: number
  universeSize: number
  lastCycleAt: number | null
  settingsVersionApplied: number | null
  degradedSymbols: string[]
  flags: BotFlags
  recentErrors: BotError[]
  botVersion: string
  /** Sólo la sesión con plata real: si puede abrir, sólo cuidar, o nada, y qué le falta. */
  real: RealGate | null
}

export interface EquityView {
  id: number
  at: number
  saldo: number
  equity: number
  margenEnUso: number
  protegido: number
  capitalBase: number
  capitalOperable: number
  shadowEquity: number | null
  kind: EquitySnapshotKind
}

export interface CommandView {
  id: string
  kind: CommandKind
  payload: Record<string, unknown>
  status: CommandStatus
  createdAt: number
  expiresAt: number | null
  claimedAt: number | null
  finishedAt: number | null
  result: CommandResult | null
  requestedBy: string
  /**
   * Vencido según el reloj de la base: `expired`, o todavía `pending` con el plazo
   * cumplido (sin bot nadie lo marca, pero ya no se va a ejecutar).
   */
  expired: boolean
}

/** El libro de la cartera real, calculado de las posiciones (spec §7). */
export interface LedgerView {
  capitalInicial: number
  startedAt: number
  /** I₀ + resultado de las cerradas − comisiones y funding ya pagados por las abiertas. */
  saldo: number
  protegido: number
  baseBlindaje: number
  closedCount: number
  wonCount: number
  /** 00:00 de Buenos Aires del día de `now`. */
  dayStart: number
  /** Equity al empezar el día (último punto de la curva hasta `dayStart`, o I₀): la base del "hoy". */
  equityAtDayStart: number
}

export interface LivePayload {
  /** Ficha opaca: se manda de vuelta en `since` y, si nada cambió, la respuesta es `{ unchanged: true }`. */
  version: string
  sessionId: string
  /** Reloj de la base al responder: el latido y los precios se miden contra éste. */
  now: number
  /** Sin latido hace más de 60 s (o sin latido nunca). */
  offline: boolean
  market: MarketSnapshotView | null
  /** Sólo las reales; la sombra no se muestra en vivo. */
  open: OpenPositionView[]
  botStatus: BotStatusView | null
  equityLast: EquityView | null
  settingsVersion: number | null
  settings: Settings | null
  ledger: LedgerView
  /** Los últimos comandos de la sesión, lo más nuevo primero ("enviado al bot… ✓ aplicado"). */
  commands: CommandView[]
  /** Cómo está la sesión real según la base (null en papel): manda sobre el latido en el estado del bot. */
  realStatus: RealStatus | null
}

export interface LiveUnchanged {
  unchanged: true
}

export type LiveResponse = LivePayload | LiveUnchanged
