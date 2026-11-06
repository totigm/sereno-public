import type { Candle, Decision, LearningState } from '@sereno/core'
import type { LearningChange } from '@sereno/core/src/learning/state'
import type { botLease, botStatus, CandleKey, EquityPoint, MarketSymbolView, RealEventInput, RealReadinessInput, sessions, SymbolUpsert, UniverseDayEntry } from '@sereno/db'
import type { BookResult } from './book'
import type { SettingsVersion } from './settings'

// Todo lo que un escenario escribe en la base, armado en memoria y sin IO: el
// generador es puro (el "ahora" entra como parámetro) y `write.ts` lo vuelca.

export interface ForwardReturn {
  forwardReturn4h?: number
  forwardReturn24h?: number
}

export interface DemoSession {
  row: typeof sessions.$inferInsert
  settings: SettingsVersion[]
  universe: { day: string; symbols: UniverseDayEntry[] }[]
  books: { real: BookResult; shadow: BookResult } | null
  decisions: Decision[]
  // Retorno a 4 h y 24 h de cada decisión, por `símbolo|cierre de vela`.
  forwardReturns: Map<string, ForwardReturn>
  equity: EquityPoint[]
  marketSnapshot: { updatedAt: number; version: number; symbols: MarketSymbolView[] } | null
  bot: { status: typeof botStatus.$inferInsert; lease: typeof botLease.$inferInsert } | null
  learning: { state: LearningState; log: LearningChange[] } | null
  // Sólo la sesión con plata real: lo que pasó con Binance.
  realEvents?: RealEventInput[]
}

// Los chequeos de la cuenta de Binance que guarda el bot, con su propio reloj.
export type DemoReadiness = RealReadinessInput & { checkedAt: number }

export interface DemoDataset {
  scenario: string
  seed: number
  now: number
  // `observedSpread` es el medio spread medido, como lo guarda el bot.
  symbols: { row: SymbolUpsert; observedSpread: number }[]
  // Una sola tabla para todas las sesiones, como en el bot: las velas salen del mismo
  // mercado que las posiciones de la simulación en vivo y del replay.
  candles: { key: CandleKey; items: Candle[] }[]
  sessions: DemoSession[]
  // Sólo los escenarios con plata real.
  readiness?: DemoReadiness
}

export const decisionKey = (symbol: string, t: number): string => `${symbol}|${t}`
