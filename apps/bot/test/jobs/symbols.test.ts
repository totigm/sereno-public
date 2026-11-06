import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { FakeBinance } from '../../src/binance/fake/server'
import { EXCHANGE_INFO } from '../../src/binance/fake/fixtures'
import { refreshSymbols } from '../../src/jobs/symbols'
import { silentLogger } from '../../src/logger'
import { restFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'

const NOW = Date.UTC(2026, 9, 31, 0, 5, 0)
const ALL = EXCHANGE_INFO.symbols.map((s) => s.symbol)

let fake: FakeBinance
let t: TestDb

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
  await t.query('delete from symbols where symbol = any($1)', [ALL])
})

function deps() {
  const { rest, limiter } = restFor(fake, NOW)
  return { deps: { rest, repos: t.repos, logger: silentLogger }, limiter }
}

describe('refreshSymbols', () => {
  it('guarda cada contrato de exchangeInfo con su intervalo de funding y el mmr de settings', async () => {
    const { deps: d } = deps()
    const { contracts, fundingIntervals } = await refreshSymbols(d, DEFAULT_SETTINGS.risk)

    expect(contracts.map((c) => c.symbol)).toEqual(ALL)
    expect(fundingIntervals.get('SOLUSDT')).toBe(4)

    const stored = new Map((await t.repos.symbols.all()).filter((s) => ALL.includes(s.symbol)).map((s) => [s.symbol, s]))
    expect([...stored.keys()].sort()).toEqual([...ALL].sort())
    expect(stored.get('BTCUSDT')).toMatchObject({
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      minNotional: 50,
      minQty: 0.001,
      stepSize: 0.001,
      tickSize: 0.1,
      quantityPrecision: 3,
      underlyingType: 'COIN',
      underlyingSubType: ['PoW'],
      onboardDate: 1569398400000,
      fundingIntervalHours: 8,
      liquidationFee: 0.0125,
      mmr: 0.004,
      observedSpread: null,
    })
    expect(stored.get('ETHUSDT')).toMatchObject({ mmr: 0.005, fundingIntervalHours: 8 })
    expect(stored.get('SOLUSDT')).toMatchObject({ mmr: 0.02, fundingIntervalHours: 4, minQty: 1 })
    expect(stored.get('1000PEPEUSDT')).toMatchObject({ fundingIntervalHours: 1 })
    // Sin fila en fundingInfo: 8 horas (spec §3). Los no operables también se guardan.
    expect(stored.get('XAUUSDT')).toMatchObject({ fundingIntervalHours: 8, underlyingType: 'COMMODITY' })
    expect(stored.get('OLDUSDT')).toMatchObject({ status: 'SETTLING' })
  })

  it('un refresco no borra el spread observado y actualiza lo que cambió', async () => {
    const { deps: d } = deps()
    await refreshSymbols(d, DEFAULT_SETTINGS.risk)
    await t.repos.symbols.setObservedSpread('SOLUSDT', 0.0003)
    await refreshSymbols(d, { ...DEFAULT_SETTINGS.risk, mmrBySymbol: { SOLUSDT: 0.01 } })
    const sol = (await t.repos.symbols.all()).find((s) => s.symbol === 'SOLUSDT')
    expect(sol).toMatchObject({ mmr: 0.01, observedSpread: 0.0003 })
  })

  it('usa una llamada de peso 1 y una del límite de funding', async () => {
    const { deps: d, limiter } = deps()
    await refreshSymbols(d, DEFAULT_SETTINGS.risk)
    expect(fake.requests.map((r) => r.path).sort()).toEqual(['/fapi/v1/exchangeInfo', '/fapi/v1/fundingInfo'])
    expect(limiter.used('weight')).toBe(1)
    expect(limiter.used('funding')).toBe(1)
  })
})
