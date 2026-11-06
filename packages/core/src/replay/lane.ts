import type { Settings } from '@sereno/shared'
import { Account } from '../capital/account'
import { TradingEngine } from '../engine/engine'
import type { EngineFailure, PortfolioDeps, Scorer } from '../engine/types'
import { PaperExchange } from '../exchange/paper-exchange'
import type { EngineEvent, LearningState, SymbolInfo } from '../types'
import { SimClock } from './clock'
import { LevelBook } from './level-book'

// Una corrida simulada: un motor con su exchange en papel y su cuenta (y los de la
// sombra), su reloj y sus abiertas. El replay corre una; el ajuste de parámetros corre
// una por combinación, en paralelo sobre las mismas velas.

export interface LaneOptions {
  infos: Record<string, SymbolInfo>
  settings: Settings
  learning: LearningState
  capital: number
  // Instante inicial del reloj: el motor arma con él el día de su corte diario.
  start: number
  idPrefix: string
  shadow: boolean
  scorer?: Scorer
  sink: (event: EngineEvent) => void
  onFailure: (failure: EngineFailure) => void
}

export interface Lane {
  readonly engine: TradingEngine
  readonly clock: SimClock
  readonly levels: LevelBook
}

export function createLane(options: LaneOptions): Lane {
  const { settings, capital } = options
  const clock = new SimClock(options.start)
  const now = (): number => clock.now
  const portfolio = (): PortfolioDeps => ({
    exchange: new PaperExchange({ settings: settings.risk, infos: options.infos, clock: now, initialBalance: capital }),
    account: new Account({ capitalInicial: capital, reinvest: settings.capital.reinvest, protectPct: settings.capital.protectPct, onShield: settings.capital.onShield }),
  })
  const levels = new LevelBook()
  const engine = new TradingEngine({
    ...portfolio(),
    settings,
    learning: options.learning,
    clock: now,
    sink: (event) => {
      levels.apply(event)
      options.sink(event)
    },
    onFailure: options.onFailure,
    idPrefix: options.idPrefix,
    ...(options.shadow ? { shadow: portfolio() } : {}),
    ...(options.scorer ? { scorer: options.scorer } : {}),
  })
  return { engine, clock, levels }
}
