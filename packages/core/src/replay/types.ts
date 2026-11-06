import type { Settings } from '@sereno/shared'
import type { EngineFailure, Scorer } from '../engine/types'
import type { ParamCombo } from '../learning/params'
import type { ShadowComparison } from '../learning/shadow'
import type { ViewTimeframe } from '../market/market-view'
import type { CandleList } from './packed-candles'
import type { Stats } from '../stats/stats'
import type {
  AccountSnapshot,
  Candle,
  ClosedPosition,
  Decision,
  EngineEvent,
  FundingEvent,
  FuturesSnapshot,
  LearningState,
  Position,
  SignalId,
  SymbolInfo,
} from '../types'

// Contratos del replay (spec §9): los datos históricos que recibe, la sesión que simula
// y el resultado que devuelve.

// `C`: arreglos de `Candle` (lo que arman los tests y la investigación) o velas en
// columnas (`PackedCandles`, lo que usa el bot: ver `compactReplayData`).
export interface PricedCandles<C = Candle[]> {
  last: C
  // Precio de marca. Sólo se lee la de 15m: stops, take profit y liquidación se resuelven
  // con velas de marca de 15 minutos (spec §6); 1h y 4h deciden con último precio.
  mark: C
}

// El mercado histórico. Cada serie trae su calentamiento antes de `from` (spec §5.2).
export interface ReplayData<C = Candle[]> {
  // Universo de cada día UTC (`YYYY-MM-DD`), ya elegido con `selectUniverse` y el volumen
  // de las velas diarias del día anterior. Tiene que cubrir todos los días del replay.
  symbolsByDay: Record<string, string[]>
  // Las velas de cada moneda tienen que llegar hasta `to` (o hasta su deslistado real)
  // aunque la moneda salga del universo: el fin de la serie de 15m es el deslistado (spec
  // §9), y una abierta que se mantiene fuera del universo se cerraría ahí como deslistada.
  // Bajarlas sólo para los días en que la moneda está en el universo no alcanza.
  candles: Record<string, Record<ViewTimeframe, PricedCandles<C>>>
  // Historial de `fundingRate` con la marca de cada `fundingTime`. Sin una marca válida
  // (Binance la deja vacía en registros viejos), se cobra con la apertura de la vela de
  // marca de 15m en que cae `at` (o la de último precio si falta, ver `missingMarkWindows`).
  funding: Record<string, FundingEvent[]>
  futures: Record<string, FuturesSnapshot[]>
  infos: Record<string, SymbolInfo>
  // Velas de último precio de BTC para su contexto (régimen y volatilidad extrema): las de
  // 15m necesitan `BTC_15M_CANDLES_FOR_BASELINE` de calentamiento para la media de 30 días.
  btc: { '15m': Candle[]; '4h': Candle[] }
}

export interface ReplayProgress {
  // Días simulados (1…of), uno por día UTC terminado.
  day: number
  of: number
}

export interface ReplayInput extends ReplayData<CandleList> {
  // Identifica la corrida: los ids de posición quedan `replay-<id>-real-…`.
  id: string
  settings: Settings
  learningInit: LearningState
  capital: number
  // Período simulado [from, to), alineado a velas de 15m (ms UTC).
  from: number
  to: number
  // Ajuste semanal de parámetros dentro del replay (spec §8.3; apagado por defecto en la UI).
  paramTuning: boolean
  // Fiabilidad semanal de las señales (spec §8.1, segunda vía) los domingos a las 00:30 UTC,
  // antes del ajuste de parámetros, como el job semanal del bot. Apagada por defecto.
  reliability?: boolean
  // Grilla del ajuste; por defecto la de 135 combinaciones de spec §8.3.
  paramGrid?: readonly ParamCombo[]
  // Puntaje compuesto; por defecto `computeComposite` (con las señales de cada vista
  // calculadas una sola vez para todas las carteras, ver `perViewScorer`).
  scorer?: Scorer
  // Guardar las decisiones en `result.decisions` (por defecto sí). Son lo más pesado del
  // resultado (unos 550 MB en 90 días × 30 monedas): quien ya las persiste desde el `sink`
  // (eventos `decisions`) puede no guardarlas, y el resto del resultado sale igual.
  keepDecisions?: boolean
  sink: (event: EngineEvent) => void
  // Si devuelve una promesa, el replay no sigue con el día siguiente hasta que se resuelva:
  // ahí se puede guardar lo del día (el sink no puede esperar) o cortar tirando un error.
  progress?: (progress: ReplayProgress) => void | Promise<void>
}

// Lo real (lo aprendido) y la sombra, siempre por separado: las estadísticas y el
// veredicto no aceptan libros mezclados.
export interface Books<T> {
  real: T
  shadow: T
}

// Cuenta de cada cartera al cierre de una vela (lo que guarda `equity_snapshots`).
export interface ReplayEquityPoint {
  at: number
  real: AccountSnapshot
  shadow: AccountSnapshot
}

// Barra del histograma de S′: [from, to), salvo la última, que incluye a +1.
export interface HistogramBin {
  from: number
  to: number
  count: number
}

// Correlación de Pearson entre los valores de cada par de señales en las decisiones
// donde las dos tenían dato (null con menos de dos pares o sin varianza), en el orden de
// `SIGNAL_IDS`, y cuántos pares hubo.
export interface SignalCorrelation {
  signals: SignalId[]
  rho: (number | null)[][]
  pairs: number[][]
}

// Tramo de decisiones consecutivas de una moneda (velas de 15m con `t` de `from` a `to`)
// en las que faltó un dato.
export interface DataGap {
  symbol: string
  from: number
  to: number
  decisions: number
}

// Tramo en que faltó una señal.
export interface MissingSignalWindow extends DataGap {
  signal: SignalId
}

// Tramo sin la vela de marca de 15m que abre en cada `t`: la de último precio hizo de
// marca, así que ahí stops, take profit y liquidación dispararon con el último precio
// (spec §6 pide la marca) y las abiertas se valuaron con él.
export type MissingMarkWindow = DataGap

// Una corrida del walk-forward semanal: el domingo `at` y la combinación que simulaba.
export interface TuningRun {
  at: number
  params: ParamCombo
}

// `tuning` presente: la falla es de una corrida del ajuste de parámetros, no de la
// principal. Los trades de esa combinación quedaron incompletos para el walk-forward.
// Las del ajuste se agrupan por domingo, operación, símbolo y mensaje (una falla de datos
// se repetiría en cada combinación): `tuning` es la primera corrida donde pasó y `count`
// cuántas veces pasó ese domingo.
export type EngineReplayFailure = Omit<EngineFailure, 'error'> & { error: string; tuning?: TuningRun; count?: number }

// Un aviso del motor que el replay no pudo leer (un drawdown sin pico o equity). La
// operación del motor terminó entera; lo que falta es lo que el replay saca del aviso.
export interface EventReplayFailure {
  operation: 'event'
  event: EngineEvent['type']
  at: number
  error: string
}

export type ReplayFailure = EngineReplayFailure | EventReplayFailure

// La pausa por drawdown máximo de lo real (pico y equity con que se disparó).
export interface DrawdownPause {
  at: number
  peak: number
  equity: number
}

// Lo que el reporte tiene que declarar además de "resolución de 15 minutos, peor caso
// intra-vela" (spec §6), porque ahí el replay no pudo ser fiel al bot o al peor caso.
// Vale siempre, además: el blindaje se evalúa también con toda la cartera en su extremo
// favorable a la vez (ver `candle-player`), un momento que pudo no existir.
export interface ReplayCaveats {
  // En un replay nadie reanuda: desde `at` lo real no abre más hasta el final, mientras la
  // sombra (que no se pausa) sigue operando y la comparación sigue contra ella. Puede
  // dispararse en el punto de la vela en que toda la cartera está en su extremo adverso.
  drawdownPause: DrawdownPause | null
  // Velas (por moneda) recorridas con la sombra abierta del lado contrario a lo real. El
  // precio es uno solo y se recorrió en el orden de lo real, que para la sombra es el
  // extremo favorable primero: ahí sus salidas y su drawdown del peor caso son optimistas
  // y la comparación con lo aprendido se inclina a favor de la sombra.
  shadowOppositeSideCandles: number
}

export interface ReplayResult {
  closed: Books<ClosedPosition[]>
  // Abiertas al terminar el período (no se cierran: el reporte las muestra como tales).
  open: Books<Position[]>
  equity: ReplayEquityPoint[]
  // Vacío con `keepDecisions: false`.
  decisions: Decision[]
  // `maxDrawdownPct` es el drawdown máximo por vela en el peor caso: el pico de equity al
  // cierre de una vela contra el momento en que toda la cartera está en su extremo adverso.
  stats: Books<Stats>
  shadowComparison: ShadowComparison
  // Pesos, confianza, penitencias, parámetros (si el ajuste estaba prendido) y la
  // fiabilidad semanal (si `reliability` estaba prendida).
  learningFinal: LearningState
  signalHistogram: HistogramBin[]
  correlation: SignalCorrelation
  missingSignalWindows: MissingSignalWindow[]
  missingMarkWindows: MissingMarkWindow[]
  // Monedas evaluadas cada día: el universo más las que se mantuvieron por tener abiertas.
  universeByDay: Record<string, string[]>
  caveats: ReplayCaveats
  failures: ReplayFailure[]
}
