// Indicadores técnicos: funciones puras sobre `number[]` o `Candle[]` que
// devuelven arrays alineados con la entrada, con NaN mientras no hay dato.
export { sma } from './sma'
export { ema } from './ema'
export { rma } from './wilder'
export { rsi } from './rsi'
export { macd, type MacdResult } from './macd'
export { atr, trueRange } from './atr'
export { adx } from './adx'
export { bollinger, type BollingerResult } from './bollinger'
export { donchian, type DonchianResult } from './donchian'
export { vwapDaily, utcDayStart } from './vwap'
export { realizedVol } from './realized-vol'
