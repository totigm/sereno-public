import type { RealReadinessRow } from '@sereno/db'
import { READINESS_STALE_MS, REAL_CHECK_LABELS, type BinanceEnv, type RealCheck, type RealCheckId, type RealStatus } from '@sereno/shared'

// Qué falta para operar con plata real, leído de los chequeos que guarda el bot (el
// dashboard nunca llama a Binance). Lo usan la pantalla, para explicar por qué el botón
// está apagado, y las acciones, para no confiar en lo que mande el navegador.

export interface ReadinessView {
  env: BinanceEnv
  /** `SERENO_REAL_TRADING=on` en el bot que corrió los chequeos. */
  enabled: boolean
  keysPresent: boolean
  checks: RealCheck[]
  checkedAt: number
  /** Más de 15 minutos sin chequear: no habilitan nada. */
  stale: boolean
  /** USDT disponibles en la billetera de futuros; null si el bot no los pudo leer. */
  walletAvailable: number | null
}

export type Readiness = { ok: true } | { ok: false; missing: string[] }

/** `now` es el reloj de la base, el mismo que selló `checkedAt`. */
export function readinessView(row: RealReadinessRow, now: number): ReadinessView {
  const checkedAt = row.checkedAt.getTime()
  return {
    env: row.env,
    enabled: row.enabled,
    keysPresent: row.keysPresent,
    checks: row.checks,
    checkedAt,
    stale: now - checkedAt > READINESS_STALE_MS,
    walletAvailable: row.walletAvailable,
  }
}

// Una sesión nueva toma el entorno de los chequeos, y su capital se mide contra la
// billetera al crearla: los chequeos de la sesión anterior no le aplican.
const NOT_FOR_A_NEW_SESSION: readonly RealCheckId[] = ['wallet', 'env_match']

export const WALLET_UNREAD = 'Que el bot lea la billetera de futuros'

/**
 * Lo que falta según los chequeos, en el orden en que se resuelve: que el bot los corra,
 * que sean recientes, las claves, la variable y cada chequeo que falló. Para una sesión
 * nueva no cuentan la billetera ni el entorno de la anterior, pero sí que el bot haya
 * leído la billetera: sin eso no hay contra qué medir el capital.
 */
export function readinessMissing(readiness: ReadinessView | null, { newSession }: { newSession: boolean }): string[] {
  if (readiness === null) return ['Que el bot revise tu cuenta de Binance (todavía no corrió los chequeos)']
  const missing: string[] = []
  if (readiness.stale) missing.push('Chequeos recientes: los últimos son de hace más de 15 minutos')
  if (!readiness.keysPresent) missing.push('Las claves de operación (BINANCE_TRADE_API_KEY y BINANCE_TRADE_API_SECRET)')
  if (!readiness.enabled) missing.push('SERENO_REAL_TRADING=on en el .env del bot')
  if (newSession && readiness.walletAvailable === null) missing.push(WALLET_UNREAD)
  for (const check of readiness.checks) {
    if (check.status !== 'fail' || check.id === 'keys') continue
    if (newSession && NOT_FOR_A_NEW_SESSION.includes(check.id)) continue
    missing.push(REAL_CHECK_LABELS[check.id])
  }
  return missing
}

/**
 * Si se puede crear una sesión real: chequeos al día y en verde, y la real anterior
 * apagada y sin abiertas (crear la archiva). La acción no pasa `openPositions`: eso lo
 * decide `archiveReal`, con la fila bloqueada.
 */
export function canCreateReal(readiness: ReadinessView | null, activeReal: { status: RealStatus; openPositions?: number } | null): Readiness {
  const missing = readinessMissing(readiness, { newSession: true })
  if (activeReal?.status === 'on') missing.push('Apagar la sesión con plata real que está prendida')
  else if ((activeReal?.openPositions ?? 0) > 0) missing.push('Que se cierren las posiciones abiertas de la sesión con plata real anterior')
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
