import type { ShadowComparison } from '@sereno/core/src/learning/shadow'
import type {
  DrawdownPause,
  HistogramBin,
  MissingMarkWindow,
  MissingSignalWindow,
  ReplayFailure,
  SignalCorrelation,
} from '@sereno/core/src/replay/types'
import type { CostBreakdown, SymbolStats } from '@sereno/core/src/stats/stats'

// Reporte de un replay terminado (spec §9), el de `sessions.report`, tal como lo escribe el
// bot y lo muestra el dashboard. Todo es JSON: lo que en core puede ser `Infinity` va como
// null. Montos en USDT, fracciones en 0–1 e instantes en ms UTC, como el resto del proyecto.

export interface ReplaySymbolResult {
  symbol: string
  trades: number
  pnlNet: number
}

// Trades cerrados en cada tramo de 15 días desde el inicio del período, [from, to).
export interface ReplayFortnight {
  from: number
  to: number
  trades: number
  wins: number
  pnlNet: number
}

export interface ReplayBookStats {
  trades: number
  wins: number
  losses: number
  winRate: number
  // null: no hubo pérdidas (en core es `Infinity`).
  profitFactor: number | null
  expectancyR: number
  avgWin: number
  avgLoss: number
  bestTrade: number
  worstTrade: number
  // Por vela, en el peor caso intra-vela.
  maxDrawdownPct: number
  costs: CostBreakdown
  // Costo total / riesgo total: cuánto de cada R se fue en costos.
  costPerRiskR: number
  liquidations: number
  // Suma del pnlNet de los trades cerrados y su fracción del capital inicial.
  netPnl: number
  roi: number
  // Equity al cierre de la última vela (incluye lo no realizado de las abiertas al final).
  finalEquity: number
  openAtEnd: number
  // Por resultado neto; null con menos de dos monedas operadas (no hay con qué comparar).
  bestSymbol: ReplaySymbolResult | null
  worstSymbol: ReplaySymbolResult | null
  bySymbol: Record<string, SymbolStats>
  byFortnight: ReplayFortnight[]
}

export interface ReplayReportCaveats {
  // La pausa por drawdown máximo de lo real (en un replay nadie reanuda).
  drawdownPause: DrawdownPause | null
  // Velas recorridas con la sombra del lado contrario a lo real (sus salidas son optimistas).
  shadowOppositeSideCandles: number
  // Desde cuándo hay interés abierto y ratios dentro del período (Binance guarda 30 días;
  // nunca antes de `from`); antes esas señales faltan. null si no hubo ninguno.
  futuresDataFrom: number | null
  // Los contratos salen del exchangeInfo de hoy: los deslistados en el período no están.
  survivorshipBias: true
}

export interface ReplayReport {
  version: 1
  from: number
  to: number
  days: number
  capital: number
  paramTuning: boolean
  // `continued`: arrancó con lo aprendido en la simulación `fromSessionId`.
  learning: { origin: 'zero' | 'continued'; fromSessionId: string | null }
  stats: { real: ReplayBookStats; shadow: ReplayBookStats }
  shadowComparison: ShadowComparison
  signalHistogram: HistogramBin[]
  correlation: SignalCorrelation
  // Monedas evaluadas cada día: el universo más las que se mantuvieron por tener abiertas.
  universeByDay: Record<string, string[]>
  missingSignalWindows: MissingSignalWindow[]
  missingMarkWindows: MissingMarkWindow[]
  caveats: ReplayReportCaveats
  // Operaciones que el motor salteó; sólo las primeras van con detalle.
  failures: { total: number; first: ReplayFailure[] }
  // Monedas con datos y velas usadas: las que ya estaban en `candles` y las que se bajaron.
  // `skipped`: monedas cuyos datos Binance rechazó; quedaron fuera del universo.
  data: { symbols: string[]; skipped: { symbol: string; error: string }[]; candlesReused: number; candlesDownloaded: number }
}
