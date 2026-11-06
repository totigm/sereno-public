// Volatilidad realizada: desvío estándar de los log-retornos de la ventana,
// escalado a un día.
//
//   r[j]  = ln(close[j] / close[j − 1])
//   vol[i] = sd(r[i − window + 1 .. i]) · √candlesPerDay
//
// `sd` es el desvío muestral (÷ window − 1). `candlesPerDay` convierte la
// volatilidad por vela a volatilidad diaria (96 con velas de 15m, 24 con 1h);
// por defecto es igual a `window`, es decir, la ventana se interpreta como un
// día (el uso del bot: 96 velas de 15m de BTC, spec §5.3c).
// Calentamiento: NaN para i < window (hacen falta window + 1 cierres). Un cierre
// no positivo hace NaN las ventanas que contienen sus dos retornos.
import { assertPeriod, nanArray } from './series'

export function realizedVol(closes: readonly number[], window: number, candlesPerDay = window): number[] {
  assertPeriod(window, 'window')
  if (window < 2) throw new RangeError(`window debe ser ≥ 2 para calcular un desvío (recibido ${window})`)
  if (!(candlesPerDay > 0)) throw new RangeError(`candlesPerDay debe ser > 0 (recibido ${candlesPerDay})`)

  const returns = nanArray(closes.length)
  for (let i = 1; i < closes.length; i++) returns[i] = Math.log(closes[i]! / closes[i - 1]!)

  const scale = Math.sqrt(candlesPerDay)
  const out = nanArray(closes.length)
  for (let i = window; i < closes.length; i++) {
    let sum = 0
    for (let j = i - window + 1; j <= i; j++) sum += returns[j]!
    const mean = sum / window
    let squares = 0
    for (let j = i - window + 1; j <= i; j++) squares += (returns[j]! - mean) ** 2
    out[i] = Math.sqrt(squares / (window - 1)) * scale
  }
  return out
}
