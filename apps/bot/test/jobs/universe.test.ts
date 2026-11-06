import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ContractMeta } from '@sereno/core'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import type { SymbolUpsert } from '@sereno/db'
import type { BinanceRest } from '../../src/binance/rest'
import { FakeBinance } from '../../src/binance/fake/server'
import { computeUniverse } from '../../src/jobs/universe'
import { silentLogger } from '../../src/logger'
import { restFor } from '../helpers/binance'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'

const NOW = Date.UTC(2026, 9, 31, 0, 5, 0)
const DAY = '2026-10-31'
const SESSION = 'ses_t19_universe'

// Un contrato que ya no está en exchangeInfo pero quedó en `symbols` de un refresco anterior.
const GONE: SymbolUpsert = {
  symbol: 'GONEUSDT',
  baseAsset: 'GONE',
  quoteAsset: 'USDT',
  contractType: 'PERPETUAL',
  status: 'TRADING',
  minNotional: 5,
  minQty: 1,
  stepSize: 1,
  tickSize: 0.0001,
  quantityPrecision: 0,
  underlyingType: 'COIN',
  underlyingSubType: ['Meme'],
  onboardDate: Date.UTC(2024, 0, 1),
  fundingIntervalHours: 4,
  liquidationFee: 0.015,
  mmr: 0.02,
}

let fake: FakeBinance
let t: TestDb
let rest: BinanceRest
let contracts: ContractMeta[]

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  fake.reset()
  rest = restFor(fake, NOW).rest
  contracts = await rest.exchangeInfo()
  fake.requests = []
  await seedSession(t, SESSION)
  await t.query('delete from symbols where symbol = $1', [GONE.symbol])
  await t.repos.symbols.upsertMany([GONE])
})

function deps() {
  return { rest, repos: { symbols: t.repos.symbols, universeDays: t.repos.universeDays }, logger: silentLogger }
}

function universe(patch: Partial<Settings['universe']> = {}): Settings['universe'] {
  return { ...DEFAULT_SETTINGS.universe, ...patch }
}

describe('computeUniverse', () => {
  it('rankea por volumen de 24 h, deja afuera TradFi, stables, nuevos y no perpetuos, y guarda el día', async () => {
    const result = await computeUniverse(deps(), { sessionId: SESSION, contracts, settings: universe(), openSymbols: [], today: NOW })

    expect(result.day).toBe(DAY)
    expect(result.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', '1000PEPEUSDT'])
    expect(result.excludedByFilter).toEqual({
      XAUUSDT: 'tradfi',
      USDCUSDT: 'stablecoin',
      NEWUSDT: 'history',
      BTCUSDT_261226: 'contract_type',
      OLDUSDT: 'status',
    })
    expect(fake.requests.map((r) => r.path)).toEqual(['/fapi/v1/ticker/24hr'])

    const stored = (await t.repos.universeDays.forDay(SESSION, DAY))?.symbols
    expect(stored).toEqual(result.entries)
    expect(stored?.map((e) => [e.symbol, e.rank, e.quoteVolume24h, e.pinned])).toEqual([
      ['BTCUSDT', 1, 12_000_000_000, false],
      ['ETHUSDT', 2, 6_500_000_000, false],
      ['SOLUSDT', 3, 2_100_000_000, false],
      ['1000PEPEUSDT', 4, 900_000_000, false],
    ])
    // El snapshot de mínimos del contrato ese día.
    expect(stored?.[0]?.filters).toEqual(contracts.find((c) => c.symbol === 'BTCUSDT')?.filters)
    expect(stored?.every((e) => e.keptOpen === undefined && e.delisted === undefined)).toBe(true)
  })

  it('guarda las que quedaron afuera ese día con su motivo y el dato del contrato que no pasó', async () => {
    const result = await computeUniverse(deps(), { sessionId: SESSION, contracts, settings: universe(), openSymbols: [], today: NOW })

    const excluded = {
      XAUUSDT: { reason: 'tradfi' },
      USDCUSDT: { reason: 'stablecoin', detail: 'USDC' },
      NEWUSDT: { reason: 'history', detail: '2026-10-15' },
      BTCUSDT_261226: { reason: 'contract_type', detail: 'CURRENT_QUARTER' },
      OLDUSDT: { reason: 'status', detail: 'SETTLING' },
    }
    expect(result.excluded).toEqual(excluded)
    expect((await t.repos.universeDays.forDay(SESSION, DAY))?.excluded).toEqual(excluded)
  })

  it('las excluidas a mano y las fijadas que no entran (sin contrato o por filtro) quedan afuera, marcadas', async () => {
    await computeUniverse(deps(), {
      sessionId: SESSION,
      contracts,
      settings: universe({ excluded: ['ETHUSDT'], pinned: ['NEWUSDT', 'NOPEUSDT', 'SOLUSDT'] }),
      openSymbols: [],
      today: NOW,
    })

    const stored = await t.repos.universeDays.forDay(SESSION, DAY)
    expect(stored?.symbols.map((e) => e.symbol)).toEqual(['BTCUSDT', 'SOLUSDT', '1000PEPEUSDT'])
    expect(stored?.excluded).toMatchObject({
      ETHUSDT: { reason: 'excluded' },
      NEWUSDT: { reason: 'history', detail: '2026-10-15', pinned: true },
      NOPEUSDT: { reason: 'no_contract', pinned: true },
    })
    // Una fijada que entró no es una excluida; las no fijadas no llevan la marca.
    expect(stored?.excluded.SOLUSDT).toBeUndefined()
    expect(stored?.excluded.ETHUSDT?.pinned).toBeUndefined()
  })

  it('anota las abiertas que se mantienen (por filtro o deslistadas) y los fijados que no entran', async () => {
    const result = await computeUniverse(deps(), {
      sessionId: SESSION,
      contracts,
      settings: universe({ topN: 3, pinned: ['SOLUSDT', 'NEWUSDT'] }),
      openSymbols: ['1000PEPEUSDT', 'OLDUSDT', 'GONEUSDT'],
      today: NOW,
    })

    expect(result.symbols).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'OLDUSDT', 'GONEUSDT'])
    expect(result.keptOpen).toEqual({ OLDUSDT: 'status' })
    expect(result.delisted).toEqual(['GONEUSDT'])
    expect(result.pinnedExcluded).toEqual({ NEWUSDT: 'history' })

    // El ranking es por volumen de 24 h, no por el orden del universo (que pone primero
    // las fijadas): SOL entra fijada pero mueve menos que BTC y ETH. Empates por nombre.
    const day = await t.repos.universeDays.forDay(SESSION, DAY)
    const stored = day?.symbols
    expect(stored?.map((e) => [e.symbol, e.rank])).toEqual([
      ['BTCUSDT', 1],
      ['ETHUSDT', 2],
      ['SOLUSDT', 3],
      ['1000PEPEUSDT', 4],
      ['GONEUSDT', 5],
      ['OLDUSDT', 6],
    ])
    expect(stored?.find((e) => e.symbol === 'SOLUSDT')).toMatchObject({ rank: 3, pinned: true, quoteVolume24h: 2_100_000_000 })
    // Fuera del top pero abierta: se mantiene sin motivo de filtro.
    expect(stored?.find((e) => e.symbol === '1000PEPEUSDT')).toMatchObject({ rank: 4, pinned: false, quoteVolume24h: 900_000_000 })
    expect(stored?.find((e) => e.symbol === '1000PEPEUSDT')?.keptOpen).toBeUndefined()
    expect(stored?.find((e) => e.symbol === 'OLDUSDT')).toMatchObject({ rank: 6, keptOpen: 'status', quoteVolume24h: 0 })
    // Deslistada: los mínimos salen de la última fila conocida en `symbols`.
    expect(stored?.find((e) => e.symbol === 'GONEUSDT')).toEqual({
      symbol: 'GONEUSDT',
      rank: 5,
      quoteVolume24h: 0,
      pinned: false,
      delisted: true,
      filters: { minNotional: 5, minQty: 1, stepSize: 1, tickSize: 0.0001, quantityPrecision: 0, liquidationFee: 0.015 },
    })
    // Una abierta que se mantiene no es una excluida aunque hoy no pase el filtro.
    expect(day?.excluded.OLDUSDT).toBeUndefined()
    expect(day?.excluded.NEWUSDT).toEqual({ reason: 'history', detail: '2026-10-15', pinned: true })
  })

  it('recalcular el mismo día reemplaza el snapshot', async () => {
    await computeUniverse(deps(), { sessionId: SESSION, contracts, settings: universe(), openSymbols: [], today: NOW })
    await computeUniverse(deps(), { sessionId: SESSION, contracts, settings: universe({ topN: 2 }), openSymbols: [], today: NOW + 3_600_000 })
    const stored = await t.repos.universeDays.forDay(SESSION, DAY)
    expect(stored?.symbols.map((e) => e.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(Object.keys(stored?.excluded ?? {})).toHaveLength(5)
  })

  it('una deslistada sin fila en symbols se mantiene igual, con mínimos en cero', async () => {
    await t.query('delete from symbols where symbol = $1', [GONE.symbol])
    const result = await computeUniverse(deps(), { sessionId: SESSION, contracts, settings: universe(), openSymbols: ['GONEUSDT'], today: NOW })
    expect(result.entries.at(-1)).toMatchObject({
      symbol: 'GONEUSDT',
      delisted: true,
      filters: { minNotional: 0, minQty: 0, stepSize: 0, tickSize: 0, quantityPrecision: 0, liquidationFee: 0 },
    })
  })
})
