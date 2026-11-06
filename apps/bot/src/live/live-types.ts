// Lo que el runtime en vivo recibe de afuera y lo que le ofrece a quien lo conecta.

import type { LearningState } from '@sereno/core'
import type { LearningChange } from '@sereno/core/src/learning/state'
import type { Repos } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { BinanceRest } from '../binance/rest'
import type { ReplayHooks } from './commands'

export type LiveRest = Pick<
  BinanceRest,
  | 'exchangeInfo'
  | 'fundingInfo'
  | 'ticker24h'
  | 'klines'
  | 'markPriceKlines'
  | 'premiumIndex'
  | 'bookTicker'
  | 'fundingRate'
  | 'openInterestHist'
  | 'globalLongShortAccountRatio'
  | 'takerLongShortRatio'
>

// Un cambio de aprendizaje calculado sobre el estado vigente y lo que deja en `learning_log`.
export interface LearningUpdate {
  state: LearningState
  log: LearningChange[]
}

export interface HookContext {
  sessionId: string
  repos: Repos
  now: number
  settings: Settings
  // El aprendizaje vigente del motor en vivo.
  learning: () => LearningState
  // Aplica `update` al estado vigente en el carril del motor (no a una copia de antes: el
  // ajuste semanal tarda minutos y mientras tanto cierran trades) y guarda el estado con
  // su bitácora en la misma transacción.
  updateLearning: (update: (current: LearningState) => LearningUpdate) => Promise<void>
}

// Para lo que no pasa por el motor (los datos de la cuenta de Binance): escribe ajustes
// como cualquier otro, y la sesión los aplica al leerlos.
export interface AccountHookContext {
  sessionId: string
  repos: Pick<Repos, 'settings' | 'symbols'>
  // Una línea en `bot_status.recentErrors` de la sesión (el trabajo ya la dejó en el log).
  reportError: (message: string) => void
}

// Lo que corre afuera de este runtime (Task 21): retornos a 4 h y 24 h de las decisiones
// cada hora, el ajuste de parámetros de los domingos y el worker de replays.
export interface LiveHooks extends ReplayHooks {
  forwardReturns?: (ctx: HookContext) => Promise<void>
  weekly?: (ctx: HookContext) => Promise<void>
  // El mmr y las comisiones de la cuenta: al tomar cada sesión y después una vez por día.
  accountTiers?: (ctx: AccountHookContext) => Promise<void>
}

export interface MarketFeed {
  // Suma estos símbolos al stream (lo abre la primera vez).
  want(symbols: readonly string[]): void
  // Deja en el stream sólo estos (BTC siempre queda: es el contexto de mercado).
  keepOnly(symbols: readonly string[]): void
}
