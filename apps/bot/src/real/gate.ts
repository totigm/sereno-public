// Qué puede hacer la sesión real ahora (spec de plata real, "Cómo se prende"). Pura: la
// recalcula el bot con cada lectura del estado de la sesión y de los chequeos. Las reglas
// van en orden y manda la primera que falta, así "apagada: falta X" nombra una sola causa
// salvo en los chequeos, que se listan todos.

import { REAL_CHECK_IDS, type BinanceEnv, type RealCheck, type RealCheckId, type RealGate, type RealStatus } from '@sereno/shared'

// Cada chequeo como lo que falta: el dashboard lo muestra tal cual después de "Apagada: falta ".
export const REAL_CHECK_MISSING: Record<RealCheckId, string> = {
  keys: 'las claves de operación',
  futures_enabled: 'el permiso de futuros en la clave',
  no_withdrawals: 'los retiros apagados en la clave',
  ip_restricted: 'la clave restringida por IP',
  one_way: 'la cuenta en modo de una posición por moneda',
  wallet: 'el capital asignado en la billetera de futuros',
  clock: 'la hora de la Mac igual a la de Binance',
  multi_assets_off: 'el modo multi-activos apagado',
  fee_burn_off: 'el descuento de comisiones con BNB apagado',
  env_match: 'la sesión del mismo entorno (testnet o real)',
}

export interface GateInput {
  enabled: boolean
  keysPresent: boolean
  // El del proceso (`BINANCE_ENV`).
  env: BinanceEnv
  checks: readonly RealCheck[]
  session: { realStatus: RealStatus; binanceEnv: BinanceEnv }
}

export function decideGate({ enabled, keysPresent, env, checks, session }: GateInput): RealGate {
  // Sin claves el bot no puede hablar con Binance: sólo protegen los stops que ya están allá.
  if (!keysPresent) return { mode: 'unguarded', missing: ['las claves de operación'] }
  // Una sesión de un entorno nunca toca la cuenta del otro, ni para reducir.
  if (session.binanceEnv !== env) return { mode: 'unguarded', missing: [`el entorno: la sesión es de ${session.binanceEnv === 'mainnet' ? 'real' : 'testnet'}`] }
  if (!enabled) return { mode: 'reduce_only', missing: ['SERENO_REAL_TRADING=on'] }
  if (session.realStatus === 'off') return { mode: 'reduce_only', missing: ['prenderla en Ajustes'] }
  if (session.realStatus === 'loss_floor') return { mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] }
  const failed = failedChecks(checks)
  if (failed.length > 0) return { mode: 'reduce_only', missing: failed.map((id) => REAL_CHECK_MISSING[id]) }
  return { mode: 'trading', missing: [] }
}

// Un chequeo que todavía no corrió cuenta como no pasado: antes de la primera revisión de
// la cuenta no se abre nada.
function failedChecks(checks: readonly RealCheck[]): RealCheck['id'][] {
  const byId = new Map(checks.map((c) => [c.id, c.status]))
  return REAL_CHECK_IDS.filter((id) => {
    const status = byId.get(id)
    return status === undefined || status === 'fail'
  })
}
