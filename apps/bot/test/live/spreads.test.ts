import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { bookTicker } from '../../src/binance/fake/fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { refreshSymbols } from '../../src/jobs/symbols'
import { silentLogger } from '../../src/logger'
import { saveObservedSpreads, sampleSpreads, SPREAD_SAMPLE_MS, SpreadSampler } from '../../src/live/spreads'
import { restFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0)
const DAY = 86_400_000

// Una muestra cada 5 min durante `ms`, con el medio spread que diga `value`.
function sampled(ms: number, value: (i: number) => number, symbol = 'SOLUSDT'): SpreadSampler {
  const sampler = new SpreadSampler()
  for (let i = 0; i * SPREAD_SAMPLE_MS <= ms; i++) sampler.add(symbol, T0 + i * SPREAD_SAMPLE_MS, value(i))
  return sampler
}

describe('SpreadSampler', () => {
  it('no da mediana hasta tener 24 h de muestras', () => {
    const sampler = sampled(DAY - SPREAD_SAMPLE_MS, () => 0.0003)
    expect(sampler.median('SOLUSDT', T0 + DAY - SPREAD_SAMPLE_MS)).toBeNull()
    sampler.add('SOLUSDT', T0 + DAY, 0.0003)
    expect(sampler.median('SOLUSDT', T0 + DAY)).toBeCloseTo(0.0003, 12)
  })

  it('la mediana es la de las últimas 24 h: lo más viejo deja de contar', () => {
    // Un día con 0,05 % y después medio día con 0,01 %.
    const sampler = sampled(DAY + DAY / 2, (i) => (i * SPREAD_SAMPLE_MS <= DAY ? 0.0005 : 0.0001))
    const now = T0 + DAY + DAY / 2
    expect(sampler.median('SOLUSDT', now)).toBeCloseTo(0.0003, 12)
    expect(sampler.median('SOLUSDT', now + DAY)).toBeNull()
  })
})

describe('spread observado', () => {
  let fake: FakeBinance
  let t: TestDb

  beforeAll(async () => {
    fake = await FakeBinance.start()
    t = await openTestDb()
  })

  afterAll(async () => {
    await t.query(`update symbols set observed_spread = null where symbol = 'SOLUSDT'`)
    await fake.stop()
    await t.close()
  })

  it('muestrea el libro por REST; una moneda sin libro no frena a las demás', async () => {
    const { rest } = restFor(fake, T0)
    // Una muestra vieja y enorme: cubre el día pero queda afuera de la ventana.
    const sampler = new SpreadSampler()
    sampler.add('SOLUSDT', T0, 0.5)
    fake.failNext('/fapi/v1/ticker/bookTicker', { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } })
    await sampleSpreads(rest, sampler, ['XYZUSDT', 'SOLUSDT'], T0 + DAY + 1)
    const book = bookTicker('SOLUSDT', T0)
    const fromBook = (Number(book.askPrice) - Number(book.bidPrice)) / (Number(book.askPrice) + Number(book.bidPrice))
    expect(sampler.median('SOLUSDT', T0 + DAY + 1)).toBeCloseTo(fromBook, 12)
  })

  it('guarda en symbols la mediana del día de las monedas que ya la tienen', async () => {
    const { rest } = restFor(fake, T0)
    await refreshSymbols({ rest, repos: t.repos, logger: silentLogger }, DEFAULT_SETTINGS.risk)
    await t.query(`update symbols set observed_spread = null where symbol in ('SOLUSDT', 'ETHUSDT')`)
    await saveObservedSpreads(t.repos, sampled(DAY, () => 0.0002), ['SOLUSDT', 'ETHUSDT'], T0 + DAY)
    const rows = Object.fromEntries((await t.repos.symbols.all()).map((r) => [r.symbol, r.observedSpread]))
    expect(rows.SOLUSDT).toBeCloseTo(0.0002, 12)
    expect(rows.ETHUSDT).toBeNull()
  })
})
