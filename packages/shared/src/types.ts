// Vocabulario compartido entre el bot, la base y el dashboard (spec §10).
// Las listas `as const` existen para que los enums de la base y los tipos
// salgan de la misma fuente.

export const SESSION_KINDS = ['paper_live', 'replay', 'live'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

// Estados de una sesión replay (spec §9); el dashboard los muestra tal cual.
export const REPLAY_STATUSES = ['en_cola', 'descargando', 'simulando', 'listo', 'fallido', 'cancelado'] as const
export type ReplayStatus = (typeof REPLAY_STATUSES)[number]

export const SESSION_STATUSES = ['active', 'archived', ...REPLAY_STATUSES] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

// De dónde parte el aprendizaje de una sesión, tal como se persiste en `sessions`:
// de cero, continuando el estado actual, o del resultado de un replay (`replay:<id de sesión>`).
// No confundir con `run_replay.payload.learningOrigin` (`'zero' | 'current'`, en `commands.ts`):
// ese es lo que pide el usuario al lanzar un replay; este es lo que queda registrado en la sesión.
export type LearningOrigin = 'zero' | 'continued' | `replay:${string}`

// `off`: la sesión real apagada (sólo cuida las abiertas o ya no tiene nada).
// Va al final porque el enum de Postgres sólo agrega valores sin reordenar.
export const BOT_PHASES = ['starting', 'warming', 'live', 'paused', 'waiting_lease', 'off'] as const
export type BotPhase = (typeof BOT_PHASES)[number]

export const COMMAND_STATUSES = ['pending', 'claimed', 'done', 'failed', 'expired', 'cancelled'] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]

export const EQUITY_SNAPSHOT_KINDS = ['minute', 'event'] as const
export type EquitySnapshotKind = (typeof EQUITY_SNAPSHOT_KINDS)[number]

export const POSITION_EVENT_KINDS = [
  'open',
  'stop_moved',
  'funding',
  'partial_close',
  'close',
  'liquidation',
  'order_placed',
  'order_cancelled',
] as const
export type PositionEventKind = (typeof POSITION_EVENT_KINDS)[number]
