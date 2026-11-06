import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '@sereno/core'
import { BTC_15M_CANDLES_FOR_BASELINE } from '@sereno/core/src/market/btc-context'
import { BinanceGeoBlocked } from '../../src/binance/errors'
import { FakeBinance } from '../../src/binance/fake/server'
import { GEO_BLOCK_MESSAGE } from '../../src/binance/fake/fixtures'
import { klinesWeight } from '../../src/binance/rest'
import { INTERVAL_MS, type KlineInterval, type KlineQuery } from '../../src/binance/types'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget, type CallBudget } from '../../src/jobs/budget'
import { silentLogger } from '../../src/logger'
import { WARMUP_TIMEFRAMES, warmup, type WarmupProgress } from '../../src/live/warmup'
import { restFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'

const NOW = Date.UTC(2026, 9, 31, 0, 5, 0) // 00:05 UTC: la vela de 15m en curso abrió a las 00:00
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const PRICE_TYPES = ['last', 'mark'] as const

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
  await t.query('delete from candles where symbol = any($1)', [SYMBOLS])
})

function deps(budget: CallBudget = weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW)) {
  const { rest } = restFor(fake, NOW)
  return { rest, repos: t.repos, now: () => NOW, logger: silentLogger, budget }
}

function lastClosedOpen(ms: number): number {
  return Math.floor(NOW / ms) * ms - ms
}

function klineRequests(symbol: string) {
  return fake.requests.filter((r) => r.query.symbol === symbol)
}

describe('warmup', () => {
  it('pide 300 velas cerradas por marco y tipo de precio de cada símbolo y las guarda', async () => {
    const progress: WarmupProgress[] = []
    const result = await warmup(deps(), ['ETHUSDT', 'SOLUSDT'], { candlesPerTf: 300 }, (p) => progress.push(p))

    expect(result.failed).toEqual([])
    for (const symbol of ['ETHUSDT', 'SOLUSDT']) {
      for (const tf of WARMUP_TIMEFRAMES) {
        const ms = INTERVAL_MS[tf]
        for (const priceType of PRICE_TYPES) {
          const series = result.candles[symbol]![tf][priceType]
          expect(series).toHaveLength(300)
          expect(series.every((c) => c.closed)).toBe(true)
          expect(series.at(-1)!.openTime).toBe(lastClosedOpen(ms))
          expect(series[0]!.openTime).toBe(lastClosedOpen(ms) - 299 * ms)
          expect(await t.repos.candles.range(symbol, tf, priceType, 0, NOW + ms)).toEqual(series)
        }
      }
      // Una llamada de limit=300 por marco y endpoint, cortada antes de la vela en curso.
      const requests = klineRequests(symbol)
      expect(requests).toHaveLength(6)
      for (const tf of WARMUP_TIMEFRAMES) {
        const endTime = String(Math.floor(NOW / INTERVAL_MS[tf]) * INTERVAL_MS[tf] - 1)
        for (const path of ['/fapi/v1/klines', '/fapi/v1/markPriceKlines']) {
          expect(requests.filter((r) => r.path === path && r.query.interval === tf)).toEqual([
            expect.objectContaining({ query: { symbol, interval: tf, endTime, limit: '300' } }),
          ])
        }
      }
    }
    // Las de marca vienen de markPriceKlines (volumen 0 en Binance).
    expect(result.candles.ETHUSDT!['1h'].mark.every((c) => c.volume === 0)).toBe(true)
    expect(result.candles.ETHUSDT!['1h'].last.every((c) => c.volume > 0)).toBe(true)

    // BTC entra siempre (contexto de mercado): 3 símbolos × 3 marcos × 2 tipos.
    expect(progress).toHaveLength(18)
    expect(progress.map((p) => p.done)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(progress.every((p) => p.total === 18)).toBe(true)
  })

  it('BTC 15m de último precio trae la base de 30 días más las 300, paginado de a 1500', async () => {
    const result = await warmup(deps(), ['ETHUSDT'], { candlesPerTf: 300 }, () => {})
    const ms = INTERVAL_MS['15m']
    const want = BTC_15M_CANDLES_FOR_BASELINE + 300

    const series = result.candles.BTCUSDT!['15m'].last
    expect(series).toHaveLength(want)
    expect(series.at(-1)!.openTime).toBe(lastClosedOpen(ms))
    expect(series.every((c, i) => i === 0 || c.openTime - series[i - 1]!.openTime === ms)).toBe(true)
    expect(await t.repos.candles.range('BTCUSDT', '15m', 'last', 0, NOW)).toHaveLength(want)

    // Páginas hacia atrás: cada una termina justo antes de la primera vela de la anterior.
    const pages = klineRequests('BTCUSDT').filter((r) => r.path === '/fapi/v1/klines' && r.query.interval === '15m')
    expect(pages.map((r) => r.query.limit)).toEqual(['1500', '1500', String(want - 3000)])
    const firstEnd = Math.floor(NOW / ms) * ms - 1
    expect(pages.map((r) => Number(r.query.endTime))).toEqual([firstEnd, firstEnd - 1500 * ms, firstEnd - 3000 * ms])

    // El resto de BTC lleva las 300 de siempre.
    expect(result.candles.BTCUSDT!['15m'].mark).toHaveLength(300)
    expect(result.candles.BTCUSDT!['4h'].last).toHaveLength(300)
  })

  it('cada llamada reserva su peso en el presupuesto del calentamiento antes de salir', async () => {
    const reserved: number[] = []
    const budget: CallBudget = {
      acquire: async (kind, weight) => {
        expect(kind).toBe('weight')
        reserved.push(weight)
      },
    }
    await warmup(deps(budget), ['ETHUSDT'], { candlesPerTf: 300 }, () => {})
    const expected = fake.requests.map((r) => klinesWeight(Number(r.query.limit)))
    expect(reserved).toHaveLength(fake.requests.length)
    expect([...reserved].sort()).toEqual([...expected].sort())
  })

  it('un 4xx de un símbolo lo deja afuera sin frenar a los demás', async () => {
    fake.failNext('/fapi/v1/klines', { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } })
    const progress: WarmupProgress[] = []
    const result = await warmup(deps(), ['ETHUSDT', 'SOLUSDT'], { candlesPerTf: 300, concurrency: 1 }, (p) => progress.push(p))

    expect(result.failed).toEqual([{ symbol: 'ETHUSDT', error: expect.stringContaining('Invalid symbol.') }])
    expect(Object.keys(result.candles).sort()).toEqual(['BTCUSDT', 'SOLUSDT'])
    // El resto de ETH no se pide: el símbolo ya quedó afuera.
    expect(klineRequests('ETHUSDT')).toHaveLength(1)
    expect(progress.at(-1)).toEqual({ done: 18, total: 18 })
  })

  it('un 451 corta todo el calentamiento', async () => {
    fake.failNext('/fapi/v1/klines', { status: 451, body: { code: 0, msg: GEO_BLOCK_MESSAGE } })
    await expect(warmup(deps(), ['ETHUSDT'], { candlesPerTf: 300, concurrency: 1 }, () => {})).rejects.toBeInstanceOf(BinanceGeoBlocked)
  })

  it('un 403 (bloqueo de IP o WAF) también corta todo en vez de seguir símbolo por símbolo', async () => {
    fake.failNext('/fapi/v1/klines', { status: 403, body: { code: 0, msg: 'Forbidden' } })
    await expect(warmup(deps(), ['ETHUSDT', 'SOLUSDT'], { candlesPerTf: 300, concurrency: 1 }, () => {})).rejects.toMatchObject({ status: 403 })
    expect(fake.requests).toHaveLength(1)
  })

  it('todas las series terminan en la misma vela aunque el calentamiento cruce un cierre', async () => {
    // El reloj avanza 15 minutos después de la primera serie: sin un corte único, las
    // series siguientes terminarían una vela de 15m más tarde que la primera.
    let clock = NOW
    const { rest } = restFor(fake, () => clock)
    const advancing = { rest, repos: t.repos, now: () => clock, logger: silentLogger, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => clock) }
    const result = await warmup(advancing, ['ETHUSDT'], { candlesPerTf: 300, concurrency: 1 }, () => {
      clock = NOW + INTERVAL_MS['15m']
    })
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      for (const priceType of PRICE_TYPES) {
        expect(result.candles[symbol]!['15m'][priceType].at(-1)!.openTime).toBe(lastClosedOpen(INTERVAL_MS['15m']))
      }
    }
  })

  it('con el reloj del cliente atrasado igual junta las velas cerradas pedidas', async () => {
    // A las 00:00:01 de Binance el cliente cree que son las 23:59:56: la última vela que
    // devuelve Binance todavía no cerró para él, se descarta y se pide una más vieja.
    const now = Date.UTC(2026, 9, 31, 0, 0, 1)
    const { rest } = restFor(fake, now, { clientLagMs: 5_000 })
    const lagging = { rest, repos: t.repos, now: () => now, logger: silentLogger, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => now) }
    const result = await warmup(lagging, ['ETHUSDT'], { candlesPerTf: 300 }, () => {})
    for (const tf of WARMUP_TIMEFRAMES) {
      const ms = INTERVAL_MS[tf]
      const series = result.candles.ETHUSDT![tf].last
      expect(series).toHaveLength(300)
      expect(series.every((c) => c.closed)).toBe(true)
      expect(series.at(-1)!.openTime).toBe(Math.floor(now / ms) * ms - 2 * ms)
      expect(series.every((c, i) => i === 0 || c.openTime - series[i - 1]!.openTime === ms)).toBe(true)
    }
  })

  it('una moneda con menos historia que lo pedido trae la que hay, con un pedido por serie', async () => {
    // Listada hace 100 velas de 4h: alcanza para 300 de 15m y 1h pero no de 4h.
    const H4 = INTERVAL_MS['4h']
    const listed = Math.floor(NOW / H4) * H4 - 100 * H4
    const calls: Array<{ symbol: string; interval: KlineInterval; priceType: 'last' | 'mark'; limit: number }> = []
    const page = (priceType: 'last' | 'mark') => (symbol: string, interval: KlineInterval, { endTime, limit }: KlineQuery): Promise<Candle[]> => {
      calls.push({ symbol, interval, priceType, limit: limit! })
      const ms = INTERVAL_MS[interval]
      const last = Math.floor(endTime! / ms) * ms
      const first = Math.max(listed, last - (limit! - 1) * ms)
      const out: Candle[] = []
      for (let open = first; open <= last; open += ms) out.push({ openTime: open, closeTime: open + ms - 1, open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 1, closed: true })
      return Promise.resolve(out)
    }
    const stub = {
      rest: { klines: page('last'), markPriceKlines: page('mark') },
      repos: { candles: { upsertMany: () => Promise.resolve() } },
      now: () => NOW,
      logger: silentLogger,
      budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW),
    }
    const result = await warmup(stub, ['NEWUSDT'], { candlesPerTf: 300 }, () => {})

    expect(result.failed).toEqual([])
    const fresh = result.candles.NEWUSDT!
    expect(fresh['4h'].last).toHaveLength(100)
    expect(fresh['4h'].mark).toHaveLength(100)
    expect(fresh['4h'].last[0]!.openTime).toBe(listed)
    expect(fresh['1h'].last).toHaveLength(300)
    expect(calls.filter((c) => c.symbol === 'NEWUSDT')).toHaveLength(6)
    // BTC 15m pide 3181 pero hay 1600: la segunda página corta es el principio.
    expect(result.candles.BTCUSDT!['15m'].last).toHaveLength(1600)
    expect(calls.filter((c) => c.symbol === 'BTCUSDT' && c.interval === '15m' && c.priceType === 'last').map((c) => c.limit)).toEqual([1500, 1500])
  })

  it('rechaza una cantidad de velas inválida', async () => {
    await expect(warmup(deps(), ['ETHUSDT'], { candlesPerTf: 0 }, () => {})).rejects.toThrow(RangeError)
    await expect(warmup(deps(), ['ETHUSDT'], { candlesPerTf: 2.5 }, () => {})).rejects.toThrow(RangeError)
  })
})
