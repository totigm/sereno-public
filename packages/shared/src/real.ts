// Vocabulario de la operación con plata real (la sesión `kind = 'live'`), compartido
// entre el bot, la base y el dashboard.

export const BINANCE_ENVS = ['testnet', 'mainnet'] as const
export type BinanceEnv = (typeof BINANCE_ENVS)[number]

// `loss_floor` es terminal: después del tope sólo se prende con una sesión nueva.
export const REAL_STATUSES = ['on', 'off', 'loss_floor'] as const
export type RealStatus = (typeof REAL_STATUSES)[number]

/** Por qué quedó apagada: la apagó Toti (dashboard o CLI) o un error fatal de Binance. */
export type RealOffReason = 'user' | 'fatal'

/** Tope de pérdida con el que el dashboard propone crear la sesión real (50% del capital asignado). */
export const REAL_LOSS_CAP_DEFAULT = 0.5

export const REAL_CHECK_IDS = [
  'keys',
  'futures_enabled',
  'no_withdrawals',
  'ip_restricted',
  'one_way',
  'wallet',
  'clock',
  'multi_assets_off',
  'fee_burn_off',
  'env_match',
] as const
export type RealCheckId = (typeof REAL_CHECK_IDS)[number]

/** `skipped`: el chequeo no aplica en este entorno (testnet no tiene `apiRestrictions` ni `feeBurn` confiables). */
export interface RealCheck {
  id: RealCheckId
  status: 'ok' | 'fail' | 'skipped'
  detail: string
}

export const REAL_CHECK_LABELS: Record<RealCheckId, string> = {
  keys: 'Claves de operación cargadas',
  futures_enabled: 'La clave puede operar futuros',
  no_withdrawals: 'La clave no puede hacer retiros',
  ip_restricted: 'La clave está restringida por IP',
  one_way: 'La cuenta está en modo de una posición por moneda',
  wallet: 'La billetera de futuros tiene el capital asignado',
  clock: 'La hora de la Mac coincide con la de Binance',
  multi_assets_off: 'El modo multi-activos está apagado',
  fee_burn_off: 'El descuento de comisiones con BNB está apagado',
  env_match: 'La sesión es del mismo entorno (testnet o real)',
}

// Qué puede hacer la sesión real ahora: operar; sólo reducir riesgo (falta la variable
// o un chequeo: cuida las abiertas, no abre); o nada (sin claves, sólo protegen los
// stops que ya están en Binance). `missing` dice qué falta, para "apagada: falta X".
export type RealGateMode = 'trading' | 'reduce_only' | 'unguarded'
export interface RealGate {
  mode: RealGateMode
  missing: string[]
}

/** A partir de cuándo los chequeos guardados por el bot ya no valen para habilitar la sesión. */
export const READINESS_STALE_MS = 15 * 60_000
