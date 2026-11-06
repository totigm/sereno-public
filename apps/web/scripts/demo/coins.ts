import type { SymbolInfo } from '@sereno/core'
import type { SymbolUpsert } from '@sereno/db'

// Las 30 monedas del universo de demostración: contratos reales del top de Binance
// USDT-M con un precio de referencia fijo (el último que "vio" el bot) y filtros,
// mmr y spread con los supuestos documentados en la spec (§6). La volatilidad diaria
// y el volumen sólo dan forma a las series inventadas.
export interface Coin {
  symbol: string
  baseAsset: string
  price: number
  tickSize: number
  stepSize: number
  minNotional: number
  mmr: number
  halfSpread: number
  liquidationFee: number
  fundingIntervalHours: number
  subType: string
  onboard: string
  dailyVol: number
  // Sensibilidad a BTC: las alts se mueven con el mercado.
  beta: number
  quoteVolume24h: number
  // Tasa de funding típica (por intervalo): positiva paga el long.
  funding: number
  // Binance no publica interés abierto ni ratios de todas: esas señales quedan sin dato.
  noPositioning?: boolean
}

const TOP_ALT_MMR = 0.01
const ALT_MMR = 0.02
const MAJOR_SPREAD = 0.0001
const ALT_SPREAD = 0.00025

function coin(c: Omit<Coin, 'minNotional' | 'mmr' | 'halfSpread' | 'liquidationFee' | 'fundingIntervalHours'> & Partial<Coin>): Coin {
  return { minNotional: 5, mmr: ALT_MMR, halfSpread: ALT_SPREAD, liquidationFee: 0.015, fundingIntervalHours: 8, ...c }
}

export const COINS: readonly Coin[] = [
  coin({ symbol: 'BTCUSDT', baseAsset: 'BTC', price: 72_000, tickSize: 0.1, stepSize: 0.001, minNotional: 100, mmr: 0.004, halfSpread: MAJOR_SPREAD, liquidationFee: 0.0125, subType: 'PoW', onboard: '2019-09-08', dailyVol: 0.025, beta: 1, quoteVolume24h: 14e9, funding: 0.0001 }),
  coin({ symbol: 'ETHUSDT', baseAsset: 'ETH', price: 2_600, tickSize: 0.01, stepSize: 0.001, minNotional: 20, mmr: 0.005, halfSpread: MAJOR_SPREAD, liquidationFee: 0.0125, subType: 'Layer-1', onboard: '2019-11-27', dailyVol: 0.032, beta: 1.1, quoteVolume24h: 7.5e9, funding: 0.0001 }),
  coin({ symbol: 'SOLUSDT', baseAsset: 'SOL', price: 170, tickSize: 0.01, stepSize: 1, mmr: TOP_ALT_MMR, subType: 'Layer-1', onboard: '2020-09-14', dailyVol: 0.045, beta: 1.3, quoteVolume24h: 2.8e9, funding: 0.00012 }),
  coin({ symbol: 'DOGEUSDT', baseAsset: 'DOGE', price: 0.162, tickSize: 0.00001, stepSize: 1, mmr: TOP_ALT_MMR, subType: 'Meme', onboard: '2020-07-10', dailyVol: 0.055, beta: 1.4, quoteVolume24h: 1.4e9, funding: 0.00015 }),
  coin({ symbol: 'XRPUSDT', baseAsset: 'XRP', price: 0.58, tickSize: 0.0001, stepSize: 0.1, mmr: TOP_ALT_MMR, subType: 'Payment', onboard: '2020-01-06', dailyVol: 0.04, beta: 1.1, quoteVolume24h: 1.3e9, funding: 0.0001 }),
  coin({ symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', price: 0.0112, tickSize: 0.0000001, stepSize: 1, subType: 'Meme', onboard: '2023-05-05', dailyVol: 0.075, beta: 1.6, quoteVolume24h: 9e8, funding: 0.00025 }),
  coin({ symbol: 'SUIUSDT', baseAsset: 'SUI', price: 2.08, tickSize: 0.0001, stepSize: 0.1, subType: 'Layer-1', onboard: '2023-05-03', dailyVol: 0.06, beta: 1.4, quoteVolume24h: 8e8, funding: 0.0001 }),
  coin({ symbol: 'WIFUSDT', baseAsset: 'WIF', price: 2.31, tickSize: 0.0001, stepSize: 0.1, subType: 'Meme', onboard: '2024-01-18', dailyVol: 0.085, beta: 1.7, quoteVolume24h: 6e8, funding: 0.0003, fundingIntervalHours: 4 }),
  coin({ symbol: 'BNBUSDT', baseAsset: 'BNB', price: 610, tickSize: 0.01, stepSize: 0.01, mmr: TOP_ALT_MMR, subType: 'CEX', onboard: '2020-02-10', dailyVol: 0.028, beta: 0.9, quoteVolume24h: 5.5e8, funding: 0.00008 }),
  coin({ symbol: 'ADAUSDT', baseAsset: 'ADA', price: 0.39, tickSize: 0.0001, stepSize: 1, mmr: TOP_ALT_MMR, subType: 'Layer-1', onboard: '2020-01-31', dailyVol: 0.045, beta: 1.2, quoteVolume24h: 5e8, funding: 0.0001 }),
  coin({ symbol: 'AVAXUSDT', baseAsset: 'AVAX', price: 27.4, tickSize: 0.001, stepSize: 1, mmr: TOP_ALT_MMR, subType: 'Layer-1', onboard: '2020-09-23', dailyVol: 0.05, beta: 1.3, quoteVolume24h: 4.2e8, funding: -0.00005 }),
  coin({ symbol: 'LINKUSDT', baseAsset: 'LINK', price: 13.2, tickSize: 0.001, stepSize: 0.01, mmr: TOP_ALT_MMR, subType: 'Oracle', onboard: '2020-01-17', dailyVol: 0.048, beta: 1.2, quoteVolume24h: 4e8, funding: 0.0001 }),
  coin({ symbol: 'NEARUSDT', baseAsset: 'NEAR', price: 5.15, tickSize: 0.001, stepSize: 1, subType: 'Layer-1', onboard: '2020-10-14', dailyVol: 0.055, beta: 1.3, quoteVolume24h: 3e8, funding: 0.0001 }),
  coin({ symbol: 'FETUSDT', baseAsset: 'FET', price: 1.34, tickSize: 0.0001, stepSize: 1, subType: 'AI', onboard: '2021-02-08', dailyVol: 0.065, beta: 1.5, quoteVolume24h: 2.9e8, funding: 0.00015 }),
  coin({ symbol: 'APTUSDT', baseAsset: 'APT', price: 8.9, tickSize: 0.001, stepSize: 0.1, subType: 'Layer-1', onboard: '2022-10-19', dailyVol: 0.055, beta: 1.3, quoteVolume24h: 2.5e8, funding: 0.0001 }),
  coin({ symbol: 'ARBUSDT', baseAsset: 'ARB', price: 0.61, tickSize: 0.0001, stepSize: 0.1, subType: 'Layer-2', onboard: '2023-03-23', dailyVol: 0.06, beta: 1.4, quoteVolume24h: 2.4e8, funding: 0.0001 }),
  coin({ symbol: 'OPUSDT', baseAsset: 'OP', price: 1.72, tickSize: 0.0001, stepSize: 0.1, subType: 'Layer-2', onboard: '2022-06-01', dailyVol: 0.06, beta: 1.4, quoteVolume24h: 2.3e8, funding: 0.0001 }),
  coin({ symbol: 'LTCUSDT', baseAsset: 'LTC', price: 71.3, tickSize: 0.01, stepSize: 0.001, mmr: TOP_ALT_MMR, subType: 'PoW', onboard: '2020-01-09', dailyVol: 0.038, beta: 1, quoteVolume24h: 2.2e8, funding: 0.0001 }),
  coin({ symbol: 'BCHUSDT', baseAsset: 'BCH', price: 362, tickSize: 0.01, stepSize: 0.001, subType: 'PoW', onboard: '2019-12-23', dailyVol: 0.04, beta: 1, quoteVolume24h: 2.1e8, funding: 0.0001 }),
  coin({ symbol: '1000SHIBUSDT', baseAsset: '1000SHIB', price: 0.0176, tickSize: 0.000001, stepSize: 1, subType: 'Meme', onboard: '2021-05-10', dailyVol: 0.055, beta: 1.4, quoteVolume24h: 2e8, funding: 0.0001, noPositioning: true }),
  coin({ symbol: 'DOTUSDT', baseAsset: 'DOT', price: 4.65, tickSize: 0.001, stepSize: 0.1, mmr: TOP_ALT_MMR, subType: 'Layer-0', onboard: '2020-08-18', dailyVol: 0.045, beta: 1.2, quoteVolume24h: 1.9e8, funding: 0.0001 }),
  coin({ symbol: 'TONUSDT', baseAsset: 'TON', price: 5.25, tickSize: 0.0001, stepSize: 0.1, subType: 'Layer-1', onboard: '2024-02-21', dailyVol: 0.04, beta: 0.9, quoteVolume24h: 1.8e8, funding: 0.00005, noPositioning: true }),
  coin({ symbol: 'INJUSDT', baseAsset: 'INJ', price: 21.4, tickSize: 0.001, stepSize: 0.1, subType: 'DeFi', onboard: '2020-10-23', dailyVol: 0.06, beta: 1.4, quoteVolume24h: 1.7e8, funding: 0.0001 }),
  coin({ symbol: 'AAVEUSDT', baseAsset: 'AAVE', price: 158, tickSize: 0.01, stepSize: 0.1, subType: 'DeFi', onboard: '2020-10-15', dailyVol: 0.05, beta: 1.2, quoteVolume24h: 1.6e8, funding: 0.0001 }),
  coin({ symbol: 'FILUSDT', baseAsset: 'FIL', price: 3.92, tickSize: 0.001, stepSize: 0.1, subType: 'Storage', onboard: '2020-10-16', dailyVol: 0.055, beta: 1.3, quoteVolume24h: 1.5e8, funding: 0.0001 }),
  coin({ symbol: 'UNIUSDT', baseAsset: 'UNI', price: 7.85, tickSize: 0.001, stepSize: 1, subType: 'DeFi', onboard: '2020-09-18', dailyVol: 0.05, beta: 1.2, quoteVolume24h: 1.4e8, funding: 0.0001 }),
  coin({ symbol: 'ETCUSDT', baseAsset: 'ETC', price: 19.3, tickSize: 0.001, stepSize: 0.01, subType: 'PoW', onboard: '2020-01-16', dailyVol: 0.042, beta: 1.1, quoteVolume24h: 1.3e8, funding: 0.0001 }),
  coin({ symbol: 'ATOMUSDT', baseAsset: 'ATOM', price: 4.42, tickSize: 0.001, stepSize: 0.01, subType: 'Layer-0', onboard: '2020-02-07', dailyVol: 0.045, beta: 1.2, quoteVolume24h: 1.2e8, funding: 0.0001 }),
  coin({ symbol: 'HBARUSDT', baseAsset: 'HBAR', price: 0.071, tickSize: 0.00001, stepSize: 1, subType: 'Layer-1', onboard: '2020-06-17', dailyVol: 0.05, beta: 1.2, quoteVolume24h: 1.1e8, funding: 0.0001, noPositioning: true }),
  // TRX se mueve tan poco que el stop que pide su ATR no cubre el costo de ida y vuelta.
  coin({ symbol: 'TRXUSDT', baseAsset: 'TRX', price: 0.165, tickSize: 0.00001, stepSize: 1, mmr: TOP_ALT_MMR, subType: 'Layer-1', onboard: '2020-01-15', dailyVol: 0.012, beta: 0.4, quoteVolume24h: 1e8, funding: 0.0001 }),
]

export const BTC_SYMBOL = 'BTCUSDT'

const BY_SYMBOL = new Map(COINS.map((c) => [c.symbol, c]))

export function coinOf(symbol: string): Coin {
  const found = BY_SYMBOL.get(symbol)
  if (!found) throw new Error(`Moneda fuera del universo de demostración: ${symbol}`)
  return found
}

function decimalsOf(step: number): number {
  const text = step.toString()
  if (text.includes('e-')) return Number(text.split('e-')[1])
  return text.split('.')[1]?.length ?? 0
}

export function symbolInfo(c: Coin): SymbolInfo {
  return {
    symbol: c.symbol,
    baseAsset: c.baseAsset,
    minNotional: c.minNotional,
    minQty: c.stepSize,
    stepSize: c.stepSize,
    tickSize: c.tickSize,
    quantityPrecision: decimalsOf(c.stepSize),
    mmr: c.mmr,
    liquidationFee: c.liquidationFee,
    fundingIntervalHours: c.fundingIntervalHours,
    halfSpreadRate: c.halfSpread,
    underlyingType: 'COIN',
    underlyingSubType: [c.subType],
    onboardDate: Date.parse(`${c.onboard}T08:00:00Z`),
  }
}

export function symbolRow(c: Coin): SymbolUpsert {
  const info = symbolInfo(c)
  return {
    symbol: c.symbol,
    baseAsset: c.baseAsset,
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    minNotional: info.minNotional,
    minQty: info.minQty,
    stepSize: info.stepSize,
    tickSize: info.tickSize,
    quantityPrecision: info.quantityPrecision,
    underlyingType: info.underlyingType,
    underlyingSubType: info.underlyingSubType,
    onboardDate: info.onboardDate,
    fundingIntervalHours: info.fundingIntervalHours,
    liquidationFee: info.liquidationFee,
    mmr: info.mmr,
  }
}
