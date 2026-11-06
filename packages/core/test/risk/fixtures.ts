import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import type { Position, Side, SymbolInfo } from '../../src/types'

// Contrato "tipo BTC" del ejemplo de spec §5.5: minNotional 5, stepSize 0.001,
// mmr 0.01 y medio spread 0.01%.
export function btcLikeInfo(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    minNotional: 5,
    minQty: 0.001,
    stepSize: 0.001,
    tickSize: 0.1,
    quantityPrecision: 3,
    mmr: 0.01,
    liquidationFee: 0.0125,
    fundingIntervalHours: 8,
    halfSpreadRate: 0.0001,
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    onboardDate: 0,
    ...overrides,
  }
}

type Overrides = {
  risk?: Partial<Settings['risk']>
  exits?: Partial<Settings['exits']>
  custom?: Partial<Settings['custom']>
  entry?: Partial<Settings['entry']>
}

// Ajustes del ejemplo: taker 0.0005, slippage 0.0002, k 1.5, apalancamiento máximo 5.
export function exampleSettings(overrides: Overrides = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    risk: { ...DEFAULT_SETTINGS.risk, takerFeeRate: 0.0005, slippageRate: 0.0002, ...overrides.risk },
    exits: { ...DEFAULT_SETTINGS.exits, k: 1.5, ...overrides.exits },
    custom: { ...DEFAULT_SETTINGS.custom, ...overrides.custom },
    entry: { ...DEFAULT_SETTINGS.entry, ...overrides.entry },
  }
}

export const ONE = { confidence: 1, symbol: 1, btc: 1 }

let seq = 0
export function openPosition(overrides: Partial<Position> & { side: Side }): Position {
  seq += 1
  return {
    id: `p${seq}`,
    symbol: `SYM${seq}USDT`,
    leverage: 5,
    margin: 20,
    notional: 100,
    qty: 1,
    entryPrice: 100,
    openedAt: 0,
    stopPrice: 98,
    takeProfitPrice: 104,
    liquidationPrice: 80,
    distanciaStop: 0.02,
    riesgoReal: 2,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 100,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0,
    fundingPaid: 0,
    shadow: false,
    openReason: '',
    signalsAtOpen: [],
    mode: 'auto',
    ...overrides,
  }
}
