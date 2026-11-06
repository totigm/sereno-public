// Arma el motor de una sesión en vivo sobre dos `PaperExchange` (lo real y la sombra) y
// lo retoma con un plan de restauración. El mismo camino sirve al arrancar (plan desde la
// base) y para rehacer el motor en caliente cuando cambia algo que el simulador fija al
// crearse (comisiones, slippage, mmr, contratos): ahí el plan sale del propio snapshot.
// Si el mmr de un contrato cambió, el motor recalcula la liquidación de sus abiertas y
// queda en el log; la base la toma al sincronizar las abiertas con el próximo lote.

import type { EngineEvent, LearningState, SymbolInfo } from '@sereno/core'
import { Account } from '@sereno/core/src/capital/account'
import { TradingEngine } from '@sereno/core/src/engine/engine'
import type { EngineFailure, EngineSnapshot, Scorer } from '@sereno/core/src/engine/types'
import { PaperExchange } from '@sereno/core/src/exchange/paper-exchange'
import type { Settings } from '@sereno/shared'
import type { Logger } from '../logger'
import type { AccountState, RestorePlan } from './restore'

export interface EngineBuild {
  sessionId: string
  capitalInicial: number
  settings: Settings
  learning: LearningState
  plan: RestorePlan
  infos: Record<string, SymbolInfo>
  clock: () => number
  sink: (event: EngineEvent) => void
  onFailure: (failure: EngineFailure) => void
  logger: Logger
  scorer?: Scorer
}

export function liveIdPrefix(sessionId: string): string {
  return `live-${sessionId}`
}

// Las cuentas de la sesión con lo que el plan retoma (también la real, sobre Binance).
export function sessionAccount(b: Pick<EngineBuild, 'capitalInicial' | 'settings'>, a: AccountState): Account {
  const { capital } = b.settings
  return new Account({
    capitalInicial: b.capitalInicial,
    reinvest: capital.reinvest,
    protectPct: capital.protectPct,
    onShield: capital.onShield,
    saldo: a.saldo,
    protegido: a.protegido,
    baseBlindaje: a.baseBlindaje,
  })
}

export async function buildEngine(b: EngineBuild): Promise<TradingEngine> {
  const { settings } = b
  const account = (a: AccountState) => sessionAccount(b, a)
  // La billetera simulada nunca queda negativa (el faltante ya está en los netos).
  const exchange = (a: AccountState) => new PaperExchange({ settings: settings.risk, infos: b.infos, clock: b.clock, initialBalance: Math.max(0, a.saldo) })
  const engine = new TradingEngine({
    exchange: exchange(b.plan.real),
    account: account(b.plan.real),
    shadow: { exchange: exchange(b.plan.shadow), account: account(b.plan.shadow) },
    settings,
    learning: b.learning,
    clock: b.clock,
    sink: b.sink,
    onFailure: b.onFailure,
    idPrefix: liveIdPrefix(b.sessionId),
    ...(b.scorer ? { scorer: b.scorer } : {}),
  })
  const { liquidations } = await engine.restore(b.plan.state)
  for (const { positionId, symbol, shadow, from, to, phrase } of liquidations) {
    b.logger.info({ sessionId: b.sessionId, positionId, symbol, shadow, from, to }, phrase)
  }
  return engine
}

export function planFromSnapshot(snapshot: EngineSnapshot): RestorePlan {
  const accountOf = (a: EngineSnapshot['accounts']['real']): AccountState => ({ saldo: a.saldo, protegido: a.protegido, baseBlindaje: a.baseBlindaje })
  const real = accountOf(snapshot.accounts.real)
  return {
    state: { real: snapshot.real, shadow: snapshot.shadow, waitedAt: snapshot.waitedAt },
    real,
    shadow: snapshot.accounts.shadow ? accountOf(snapshot.accounts.shadow) : { saldo: real.saldo, protegido: 0, baseBlindaje: snapshot.accounts.real.capitalInicial },
  }
}
