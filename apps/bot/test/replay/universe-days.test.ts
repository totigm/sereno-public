import { describe, expect, it } from 'vitest'
import type { ContractMeta } from '@sereno/core'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { replayUniverseDays } from '../../src/replay/universe-days'

const FILTERS = { minNotional: 5, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, quantityPrecision: 3, liquidationFee: 0.0125 }

function contract(symbol: string, patch: Partial<ContractMeta> = {}): ContractMeta {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    underlyingType: 'COIN',
    underlyingSubType: [],
    onboardDate: Date.UTC(2024, 0, 1),
    filters: FILTERS,
    ...patch,
  }
}

const CONTRACTS = [contract('AAAUSDT'), contract('BBBUSDT'), contract('CCCUSDT'), contract('DDDUSDT', { status: 'SETTLING' }), contract('XXXUSDT')]
const SETTINGS = { ...DEFAULT_SETTINGS.universe, topN: 2 }

describe('replayUniverseDays', () => {
  it('cada día con el ranking del vivo, las que siguieron por tener abiertas y sin las que Binance rechazó', () => {
    const days = replayUniverseDays({
      contracts: CONTRACTS,
      settings: SETTINGS,
      volumesByDay: {
        '2026-10-29': { XXXUSDT: 400, AAAUSDT: 300, BBBUSDT: 200, CCCUSDT: 100, DDDUSDT: 50 },
        '2026-10-30': { AAAUSDT: 100, BBBUSDT: 300, CCCUSDT: 200 },
      },
      // Lo que corrió el replay: XXX entró el 29 pero Binance rechazó sus velas.
      symbolsByDay: { '2026-10-29': ['AAAUSDT'], '2026-10-30': ['BBBUSDT', 'CCCUSDT'] },
      // DDD se mantuvo el 29 por tener una abierta aunque su contrato ya no opera.
      evaluated: { '2026-10-29': ['AAAUSDT', 'DDDUSDT'], '2026-10-30': ['BBBUSDT', 'CCCUSDT'] },
    })

    expect(days).toEqual([
      {
        day: '2026-10-29',
        symbols: [
          { symbol: 'AAAUSDT', rank: 1, quoteVolume24h: 300, pinned: false, filters: FILTERS },
          { symbol: 'DDDUSDT', rank: 2, quoteVolume24h: 50, pinned: false, filters: FILTERS, keptOpen: 'status' },
        ],
        excluded: {},
      },
      {
        day: '2026-10-30',
        symbols: [
          { symbol: 'BBBUSDT', rank: 1, quoteVolume24h: 300, pinned: false, filters: FILTERS },
          { symbol: 'CCCUSDT', rank: 2, quoteVolume24h: 200, pinned: false, filters: FILTERS },
        ],
        // XXX no tiene vela diaria del 29: sin volumen, no se rankea.
        excluded: { DDDUSDT: { reason: 'status', detail: 'SETTLING' }, XXXUSDT: { reason: 'no_volume' } },
      },
    ])
  })
})
