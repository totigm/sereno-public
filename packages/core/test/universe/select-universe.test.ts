import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { ContractMeta } from '../../src/types'
import { selectUniverse, STABLECOINS, DAY_MS } from '../../src/universe/select-universe'

const TODAY = Date.UTC(2026, 9, 31) // 2026-10-31T00:00:00Z

// Universo sintético de 40 contratos: 35 perpetuos "normales" más 5 casos límite.
const NORMAL_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT',
  'LINKUSDT', 'LTCUSDT', 'TRXUSDT', 'ATOMUSDT', 'UNIUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT',
  'OPUSDT', 'FILUSDT', 'INJUSDT', 'SUIUSDT', 'TIAUSDT', 'SEIUSDT', 'RUNEUSDT', 'AAVEUSDT',
  'MKRUSDT', 'LDOUSDT', 'ETCUSDT', 'BCHUSDT', 'XLMUSDT', 'ALGOUSDT', 'FTMUSDT', 'SANDUSDT',
  'MANAUSDT', 'GALAUSDT', 'SOLUSDT',
] as const

function contract(symbol: string, overrides: Partial<ContractMeta> = {}): ContractMeta {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    onboardDate: TODAY - 400 * DAY_MS,
    filters: { minNotional: 5, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, quantityPrecision: 3, liquidationFee: 0.0125 },
    ...overrides,
  }
}

const CONTRACTS: ContractMeta[] = [
  ...NORMAL_SYMBOLS.map((s) => contract(s)),
  contract('XAUUSDT', { underlyingType: 'COMMODITY', underlyingSubType: ['TradFi'] }),
  contract('USDCUSDT', { underlyingSubType: ['Stablecoin'] }),
  contract('NEWUSDT', { onboardDate: TODAY - 30 * DAY_MS }),
  contract('BTCUSDT_261226', { baseAsset: 'BTC', contractType: 'CURRENT_QUARTER' }),
  contract('LUNAUSDT', { status: 'SETTLING' }),
]

// Volumen decreciente según el orden de NORMAL_SYMBOLS: SOLUSDT queda 35º entre los
// candidatos válidos. Los casos límite reciben volumen alto para probar que se los
// excluye por filtro y no por ranking.
const VOLUMES: Record<string, number> = Object.fromEntries([
  ...NORMAL_SYMBOLS.map((s, i) => [s, (NORMAL_SYMBOLS.length - i) * 1_000_000]),
  ['XAUUSDT', 20_000_000],
  ['USDCUSDT', 50_000_000],
  ['NEWUSDT', 30_000_000],
  ['BTCUSDT_261226', 40_000_000],
  ['LUNAUSDT', 25_000_000],
])

function select(overrides: Partial<Parameters<typeof selectUniverse>[0]> = {}) {
  return selectUniverse({
    contracts: CONTRACTS,
    volumes: VOLUMES,
    today: TODAY,
    settings: DEFAULT_SETTINGS.universe,
    openSymbols: [],
    ...overrides,
  })
}

describe('selectUniverse', () => {
  it('tiene 40 contratos sintéticos y devuelve exactamente topN', () => {
    expect(CONTRACTS).toHaveLength(40)
    const { symbols } = select()
    expect(symbols).toHaveLength(DEFAULT_SETTINGS.universe.topN)
    expect(symbols).toEqual(NORMAL_SYMBOLS.slice(0, 30))
    expect(new Set(symbols).size).toBe(symbols.length)
  })

  it('respeta un topN distinto', () => {
    expect(select({ settings: { ...DEFAULT_SETTINGS.universe, topN: 5 } }).symbols).toEqual(NORMAL_SYMBOLS.slice(0, 5))
  })

  it('excluye XAUUSDT (COMMODITY/TradFi) salvo includeTradFi', () => {
    const off = select()
    expect(off.symbols).not.toContain('XAUUSDT')
    expect(off.excludedByFilter['XAUUSDT']).toBe('tradfi')

    const on = select({ settings: { ...DEFAULT_SETTINGS.universe, includeTradFi: true } })
    expect(on.symbols).toContain('XAUUSDT')
    expect(on.symbols).toHaveLength(30)
    expect(on.excludedByFilter).not.toHaveProperty('XAUUSDT')
  })

  it('con includeTradFi un índice sin subtipo TradFi sigue fuera por underlyingType', () => {
    const contracts = [...CONTRACTS, contract('DEFIUSDT', { underlyingType: 'INDEX', underlyingSubType: ['DeFi'] })]
    const result = select({ contracts, settings: { ...DEFAULT_SETTINGS.universe, includeTradFi: true } })
    expect(result.excludedByFilter['DEFIUSDT']).toBe('underlying_type')
  })

  it('excluye USDCUSDT y el resto de las stablecoins', () => {
    const result = select()
    expect(result.symbols).not.toContain('USDCUSDT')
    expect(result.excludedByFilter['USDCUSDT']).toBe('stablecoin')
    expect(STABLECOINS).toEqual(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDE', 'BUSD', 'USD1', 'USDD'])
  })

  it('excluye un contrato con 30 días de historia y acepta uno con exactamente minHistoryDays', () => {
    const result = select()
    expect(result.symbols).not.toContain('NEWUSDT')
    expect(result.excludedByFilter['NEWUSDT']).toBe('history')

    const contracts = [...CONTRACTS, contract('EDGEUSDT', { onboardDate: TODAY - 60 * DAY_MS })]
    const edge = select({ contracts, volumes: { ...VOLUMES, EDGEUSDT: 99_000_000 } })
    expect(edge.symbols[0]).toBe('EDGEUSDT')
    expect(edge.excludedByFilter).not.toHaveProperty('EDGEUSDT')
  })

  it('excluye contratos no perpetuos, no TRADING y con quote distinto de USDT', () => {
    const contracts = [...CONTRACTS, contract('ETHBTC', { baseAsset: 'ETH', quoteAsset: 'BTC' })]
    const result = select({ contracts })
    expect(result.excludedByFilter['BTCUSDT_261226']).toBe('contract_type')
    expect(result.excludedByFilter['LUNAUSDT']).toBe('status')
    expect(result.excludedByFilter['ETHBTC']).toBe('quote_asset')
    for (const symbol of Object.keys(result.excludedByFilter)) expect(result.symbols).not.toContain(symbol)
  })

  it('mantiene SOLUSDT abierto aunque caiga al puesto 35, al final de la lista', () => {
    const result = select({ openSymbols: ['SOLUSDT'] })
    expect(result.symbols).toHaveLength(31)
    expect(result.symbols[30]).toBe('SOLUSDT')
    expect(result.symbols.slice(0, 30)).toEqual(NORMAL_SYMBOLS.slice(0, 30))
    expect(result.excludedByFilter).not.toHaveProperty('SOLUSDT')
    // Salir del top no es un filtro: no hay motivo que explicar.
    expect(result.keptOpen).toEqual({})
    expect(result.delisted).toEqual([])
  })

  it('no duplica un símbolo abierto que ya está en el top', () => {
    const result = select({ openSymbols: ['BTCUSDT'] })
    expect(result.symbols).toHaveLength(30)
    expect(result.symbols.filter((s) => s === 'BTCUSDT')).toHaveLength(1)
  })

  it('mantiene un símbolo abierto cuyo contrato desapareció y lo marca como delisted', () => {
    const result = select({ openSymbols: ['GONEUSDT'] })
    expect(result.symbols).toHaveLength(31)
    expect(result.symbols[30]).toBe('GONEUSDT')
    expect(result.delisted).toEqual(['GONEUSDT'])
    expect(result.excludedByFilter).not.toHaveProperty('GONEUSDT')
    expect(result.keptOpen).not.toHaveProperty('GONEUSDT')
  })

  it('sin posiciones abiertas no hay delisted ni keptOpen', () => {
    const result = select()
    expect(result.delisted).toEqual([])
    expect(result.keptOpen).toEqual({})
  })

  it('mantiene un símbolo abierto aunque haya dejado de pasar un filtro y conserva el motivo en keptOpen', () => {
    const result = select({ openSymbols: ['XAUUSDT', 'LUNAUSDT'] })
    expect(result.symbols.slice(30)).toEqual(['XAUUSDT', 'LUNAUSDT'])
    expect(result.keptOpen).toEqual({ XAUUSDT: 'tradfi', LUNAUSDT: 'status' })
    expect(result.excludedByFilter).not.toHaveProperty('XAUUSDT')
    expect(result.excludedByFilter).not.toHaveProperty('LUNAUSDT')
    expect(result.delisted).toEqual([])
  })

  it('una moneda abierta excluida a mano sigue y keptOpen dice excluded', () => {
    const result = select({ openSymbols: ['BTCUSDT'], settings: { ...DEFAULT_SETTINGS.universe, excluded: ['BTCUSDT'] } })
    expect(result.symbols[30]).toBe('BTCUSDT')
    expect(result.keptOpen).toEqual({ BTCUSDT: 'excluded' })
    expect(result.excludedByFilter).not.toHaveProperty('BTCUSDT')
  })

  it('respeta pinned: van primero aunque tengan poco volumen', () => {
    const result = select({ settings: { ...DEFAULT_SETTINGS.universe, pinned: ['SOLUSDT', 'GALAUSDT'] } })
    expect(result.symbols.slice(0, 2)).toEqual(['SOLUSDT', 'GALAUSDT'])
    expect(result.symbols).toHaveLength(30)
    // Los dos fijados desplazan a los dos últimos del top.
    expect(result.symbols).not.toContain('XLMUSDT')
    expect(result.symbols).not.toContain('ALGOUSDT')
  })

  it('ignora pinned repetidos o sin contrato', () => {
    const result = select({ settings: { ...DEFAULT_SETTINGS.universe, pinned: ['SOLUSDT', 'SOLUSDT', 'GONEUSDT'] } })
    expect(result.symbols[0]).toBe('SOLUSDT')
    expect(result.symbols).toHaveLength(30)
    expect(new Set(result.symbols).size).toBe(30)
    expect(result.symbols).not.toContain('GONEUSDT')
  })

  it('un pinned que no pasa los filtros no entra y queda explicado en pinnedExcluded', () => {
    const result = select({ settings: { ...DEFAULT_SETTINGS.universe, pinned: ['XAUUSDT', 'NEWUSDT', 'SOLUSDT'] } })
    expect(result.symbols).not.toContain('XAUUSDT')
    expect(result.symbols).not.toContain('NEWUSDT')
    expect(result.symbols[0]).toBe('SOLUSDT')
    expect(result.excludedByFilter['XAUUSDT']).toBe('tradfi')
    expect(result.pinnedExcluded).toEqual({ XAUUSDT: 'tradfi', NEWUSDT: 'history' })
  })

  it('un pinned sin volumen o excluido a mano también se explica en pinnedExcluded', () => {
    const { GALAUSDT: _omitted, ...volumes } = VOLUMES
    const settings = { ...DEFAULT_SETTINGS.universe, pinned: ['GALAUSDT', 'BTCUSDT'], excluded: ['BTCUSDT'] }
    const result = select({ volumes, settings })
    expect(result.pinnedExcluded).toEqual({ GALAUSDT: 'no_volume', BTCUSDT: 'excluded' })
  })

  it('un pinned que no pasa un filtro pero tiene posición abierta sigue y va a keptOpen, no a pinnedExcluded', () => {
    const result = select({ openSymbols: ['XAUUSDT'], settings: { ...DEFAULT_SETTINGS.universe, pinned: ['XAUUSDT'] } })
    expect(result.symbols[30]).toBe('XAUUSDT')
    expect(result.keptOpen).toEqual({ XAUUSDT: 'tradfi' })
    expect(result.pinnedExcluded).toEqual({})
  })

  it('un pinned cuyo contrato no existe queda en pinnedExcluded con motivo no_contract', () => {
    const result = select({ settings: { ...DEFAULT_SETTINGS.universe, pinned: ['GHOSTUSDT', 'SOLUSDT'] } })
    expect(result.symbols).not.toContain('GHOSTUSDT')
    expect(result.symbols[0]).toBe('SOLUSDT')
    expect(result.pinnedExcluded).toEqual({ GHOSTUSDT: 'no_contract' })
    expect(result.excludedByFilter['GHOSTUSDT']).toBe('no_contract')
  })

  it('un pinned sin contrato pero con posición abierta sigue como delisted, no en pinnedExcluded', () => {
    const result = select({ openSymbols: ['GHOSTUSDT'], settings: { ...DEFAULT_SETTINGS.universe, pinned: ['GHOSTUSDT'] } })
    expect(result.symbols).toContain('GHOSTUSDT')
    expect(result.delisted).toEqual(['GHOSTUSDT'])
    expect(result.pinnedExcluded).toEqual({})
    expect(result.excludedByFilter['GHOSTUSDT']).toBeUndefined()
  })

  it('sin pinned fallidos pinnedExcluded queda vacío', () => {
    expect(select().pinnedExcluded).toEqual({})
    expect(select({ settings: { ...DEFAULT_SETTINGS.universe, pinned: ['SOLUSDT'] } }).pinnedExcluded).toEqual({})
  })

  it('respeta excluded: salen y su lugar lo ocupa el siguiente por volumen', () => {
    const result = select({ settings: { ...DEFAULT_SETTINGS.universe, excluded: ['BTCUSDT', 'ETHUSDT'] } })
    expect(result.symbols).not.toContain('BTCUSDT')
    expect(result.symbols).not.toContain('ETHUSDT')
    expect(result.symbols).toHaveLength(30)
    expect(result.symbols).toEqual(NORMAL_SYMBOLS.slice(2, 32))
    expect(result.excludedByFilter['BTCUSDT']).toBe('excluded')
  })

  it('excluded gana sobre pinned', () => {
    const result = select({ settings: { ...DEFAULT_SETTINGS.universe, pinned: ['BTCUSDT'], excluded: ['BTCUSDT'] } })
    expect(result.symbols).not.toContain('BTCUSDT')
  })

  it('un símbolo sin volumen informado no se puede rankear y queda fuera', () => {
    const { BTCUSDT: _omitted, ...volumes } = VOLUMES
    const result = select({ volumes })
    expect(result.symbols).not.toContain('BTCUSDT')
    expect(result.excludedByFilter['BTCUSDT']).toBe('no_volume')
    expect(result.symbols).toHaveLength(30)
  })

  it('desempata volúmenes iguales por símbolo para ser determinista', () => {
    const volumes = Object.fromEntries(CONTRACTS.map((c) => [c.symbol, 1]))
    const result = select({ volumes, settings: { ...DEFAULT_SETTINGS.universe, topN: 3 } })
    expect(result.symbols).toEqual(['AAVEUSDT', 'ADAUSDT', 'ALGOUSDT'])
  })

  it('es pura: no muta las entradas', () => {
    const contracts = structuredClone(CONTRACTS)
    const volumes = structuredClone(VOLUMES)
    const settings = { ...DEFAULT_SETTINGS.universe, pinned: ['SOLUSDT', 'XAUUSDT'], excluded: ['BTCUSDT'] }
    const openSymbols = ['ETHUSDT', 'BTCUSDT', 'GONEUSDT']
    select({ contracts, volumes, settings, openSymbols })
    expect(contracts).toEqual(CONTRACTS)
    expect(volumes).toEqual(VOLUMES)
    expect(settings.pinned).toEqual(['SOLUSDT', 'XAUUSDT'])
    expect(settings.excluded).toEqual(['BTCUSDT'])
    expect(openSymbols).toEqual(['ETHUSDT', 'BTCUSDT', 'GONEUSDT'])
  })
})
