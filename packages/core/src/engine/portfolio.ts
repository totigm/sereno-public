import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import type { Account } from '../capital/account'
import type { EngineExchange } from '../exchange/types'
import { learnFromClosedTrade } from '../learning/closed-trade'
import { isPenalized, releaseExpiredPenalties, symbolMultiplier, updateConfidence } from '../learning/confidence'
import { signalRecord, type LearningChange } from '../learning/state'
import { effectiveWeights } from '../learning/weights'
import type { ClosedPosition, LearningState, SignalId } from '../types'
import { AccountGuard, type GuardOptions, type GuardState } from './account-guard'
import { PositionManager, type PositionManagerDeps } from './position-manager'
import type { LiquidationRecalculated, PortfolioState } from './types'

export interface PortfolioInit {
  exchange: EngineExchange
  account: Account
  guard: GuardState
  idPrefix: string
  onProtectFailed: PositionManagerDeps['onProtectFailed']
  // Opera plata de verdad: el tope de pérdida nunca se apaga (`lossFloor`).
  realMoney?: boolean
}

// Una cartera: su exchange, su cuenta, sus abiertas y sus cortes de cuenta. Lo aprendido
// y la sombra comparten todas las reglas de capital, universo y enfriamiento; difieren
// en con qué deciden (parámetros, pesos, mMoneda) y en qué aprenden de sus trades.
export abstract class Portfolio {
  abstract readonly kind: 'real' | 'shadow'
  readonly exchange: EngineExchange
  readonly account: Account
  readonly positions: PositionManager
  readonly realMoney: boolean
  guard: AccountGuard
  learning: LearningState
  private readonly guardOptions: GuardOptions

  constructor(init: PortfolioInit, learning: LearningState, shadow: boolean) {
    this.exchange = init.exchange
    this.account = init.account
    this.realMoney = init.realMoney === true
    this.guardOptions = { drawdown: shadow ? 'rebase' : 'pause' }
    this.guard = new AccountGuard(init.guard, this.guardOptions)
    this.learning = learning
    this.positions = new PositionManager({
      exchange: init.exchange,
      shadow,
      idPrefix: init.idPrefix,
      realize: (amount, at) => {
        this.account.applyRealized(amount)
        this.guard.noteRealized(amount, at)
      },
      onProtectFailed: init.onProtectFailed,
    })
  }

  // Los ajustes con que decide esta cartera, a partir de los de la sesión.
  abstract settings(base: Settings): Settings
  abstract weights(symbol: string, base: Settings): Record<SignalId, number>
  abstract symbolMultiplier(symbol: string, now: number): number
  // Aprende de un trade cerrado y devuelve los cambios que van al diario.
  abstract learn(closed: ClosedPosition, base: Settings): LearningChange[]
  abstract releasePenalties(now: number): LearningChange[]

  inPenalty(symbol: string, now: number): boolean {
    return isPenalized(this.learning, symbol, now)
  }

  state(): PortfolioState {
    return { positions: this.positions.snapshot(), guard: this.guard.snapshot() }
  }

  restore(state: PortfolioState): LiquidationRecalculated[] {
    this.guard = new AccountGuard(state.guard, this.guardOptions)
    return this.positions.restore(state.positions)
  }
}

// Lo aprendido: θ, k, tpR y trailingR salen de `learning.params` (el ajuste semanal los
// adopta ahí, spec §8.3); los pesos con encogimiento por moneda; mMoneda por confianza.
export class LearnedPortfolio extends Portfolio {
  readonly kind = 'real'

  constructor(init: PortfolioInit, learning: LearningState) {
    super(init, learning, false)
  }

  settings(base: Settings): Settings {
    const { theta, k, tpR, trailingR } = this.learning.params
    return { ...base, entry: { ...base.entry, theta }, exits: { ...base.exits, k, tpR, trailingR } }
  }

  weights(symbol: string, base: Settings): Record<SignalId, number> {
    return effectiveWeights(this.learning, symbol, base.learning.shrinkageK)
  }

  symbolMultiplier(symbol: string, now: number): number {
    return symbolMultiplier(this.learning, symbol, now)
  }

  learn(closed: ClosedPosition, base: Settings): LearningChange[] {
    const { state, log } = learnFromClosedTrade(this.learning, closed, base.learning, closed.closedAt)
    this.learning = state
    return log
  }

  releasePenalties(now: number): LearningChange[] {
    const { state, log } = releaseExpiredPenalties(this.learning, now)
    this.learning = state
    return log
  }
}

// La sombra (spec §8): entradas y salidas por defecto del documento, pesos 1, sin
// mMoneda, y su propia penitencia en un `LearningState` aparte que sólo mueve
// `updateConfidence` con sus propios trades. Nada de lo suyo llega al diario. Su
// drawdown máximo no la pausa (ver `DrawdownBehavior`).
export class ShadowPortfolio extends Portfolio {
  readonly kind = 'shadow'

  constructor(init: PortfolioInit, learning: LearningState) {
    super(init, learning, true)
  }

  settings(base: Settings): Settings {
    // A propósito la sombra sigue los defaults actuales del código, no los congelados de la sesión (A/B: real con lo aprendido, sombra con los defaults nuevos).
    return { ...base, entry: DEFAULT_SETTINGS.entry, exits: DEFAULT_SETTINGS.exits, learning: DEFAULT_SETTINGS.learning }
  }

  weights(): Record<SignalId, number> {
    return signalRecord(1)
  }

  symbolMultiplier(): number {
    return 1
  }

  learn(closed: ClosedPosition): LearningChange[] {
    this.learning = updateConfidence(this.learning, closed, DEFAULT_SETTINGS.learning, closed.closedAt).state
    return []
  }

  releasePenalties(now: number): LearningChange[] {
    this.learning = releaseExpiredPenalties(this.learning, now).state
    return []
  }
}
