import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceHttpError, BinanceNetworkError, isKeyRejected } from '../../src/binance/errors'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance, type RecordedRequest } from '../../src/binance/fake/server'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BinanceRest, type BinanceRestOptions } from '../../src/binance/rest'
import { BINANCE_LIMITS } from '../../src/config'

const COMMISSION = '/fapi/v1/commissionRate'
const BRACKETS = '/fapi/v1/leverageBracket'
const TIME = '/fapi/v1/time'

describe('BinanceRest: pedidos firmados (USER_DATA)', () => {
  let fake: FakeBinance
  let limiter: RateLimiter
  let sleeps: number[]
  // Reloj virtual del cliente: `sleep` adelanta el reloj en vez de esperar.
  let offset = 0
  const now = (): number => Date.now() + offset

  const client = (opts: Partial<BinanceRestOptions> = {}): BinanceRest =>
    new BinanceRest({
      baseUrl: fake.baseUrl,
      limiter,
      apiKey: FAKE_API_KEY,
      apiSecret: FAKE_API_SECRET,
      maxRetries: 2,
      now,
      sleep: async (ms) => {
        sleeps.push(ms)
        offset += ms
      },
      ...opts,
    })

  const requestsTo = (path: string): RecordedRequest[] => fake.requests.filter((r) => r.path === path)

  // Lo que firmó el cliente y la firma que mandó, separados.
  const signedParts = (r: RecordedRequest): { payload: string; signature: string } => {
    const at = r.rawQuery.lastIndexOf('&signature=')
    return { payload: r.rawQuery.slice(0, at), signature: r.rawQuery.slice(at + '&signature='.length) }
  }

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    sleeps = []
    offset = 0
    limiter = new RateLimiter({ ...BINANCE_LIMITS, now })
  })

  it('commissionRate manda X-MBX-APIKEY, recvWindow 5000, timestamp y la firma HMAC-SHA256 del query', async () => {
    const rate = await client().commissionRate('BTCUSDT')
    expect(rate).toEqual({ symbol: 'BTCUSDT', makerFeeRate: 0.00018, takerFeeRate: 0.00045 })

    const [signed] = requestsTo(COMMISSION)
    expect(signed).toBeDefined()
    expect(signed!.apiKey).toBe(FAKE_API_KEY)
    const { payload, signature } = signedParts(signed!)
    expect(payload).toMatch(/^symbol=BTCUSDT&recvWindow=5000&timestamp=\d+$/)
    expect(signature).toBe(createHmac('sha256', FAKE_API_SECRET).update(payload).digest('hex'))
  })

  it('leverageBracket trae todas las monedas en un solo pedido, sin symbol', async () => {
    const brackets = await client().leverageBrackets()
    expect(brackets.map((b) => b.symbol)).toContain('BTCUSDT')
    expect(brackets.find((b) => b.symbol === 'BTCUSDT')!.brackets.length).toBeGreaterThan(1)
    const [signed] = requestsTo(BRACKETS)
    expect(signed!.query.symbol).toBeUndefined()
    expect(signedParts(signed!).payload).toMatch(/^recvWindow=5000&timestamp=\d+$/)
  })

  it('mide el desfase contra /fapi/v1/time una sola vez y lo suma al timestamp', async () => {
    // Binance va 30 s adelantado: sin el desfase, el timestamp quedaría fuera de la ventana.
    fake.now = () => now() + 30_000
    const rest = client()
    await Promise.all([rest.commissionRate('BTCUSDT'), rest.leverageBrackets()])
    await rest.commissionRate('BTCUSDT')
    expect(requestsTo(TIME)).toHaveLength(1)
    expect(fake.requests.map((r) => r.path)[0]).toBe(TIME)
    for (const r of requestsTo(COMMISSION)) {
      const timestamp = Number(r.query.timestamp)
      expect(Math.abs(timestamp - (r.at + 30_000))).toBeLessThan(1_000)
    }
  })

  it('ante -1021 renueva el desfase y reintenta una vez', async () => {
    const rest = client()
    await rest.commissionRate('BTCUSDT')
    // El reloj de Binance salta un minuto: el desfase medido al arrancar ya no sirve.
    fake.now = () => now() + 60_000
    fake.requests = []
    await expect(rest.commissionRate('BTCUSDT')).resolves.toMatchObject({ takerFeeRate: 0.00045 })
    expect(fake.requests.map((r) => r.path)).toEqual([COMMISSION, TIME, COMMISSION])
    expect(sleeps).toEqual([])
  })

  it('un -1021 que persiste después de renovar el desfase no entra en bucle', async () => {
    fake.failNext(COMMISSION, { status: 400, body: { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' } }, 5)
    const err = await client().commissionRate('BTCUSDT').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceHttpError)
    expect((err as BinanceHttpError).code).toBe(-1021)
    expect(requestsTo(COMMISSION)).toHaveLength(2)
    expect(requestsTo(TIME)).toHaveLength(2)
  })

  it('un reintento por 5xx vuelve a sellar y a firmar el pedido', async () => {
    fake.failNext(COMMISSION, { status: 503 })
    await client().commissionRate('BTCUSDT')
    const [first, second] = requestsTo(COMMISSION)
    expect(sleeps).toEqual([1_000])
    expect(Number(second!.query.timestamp)).toBeGreaterThanOrEqual(Number(first!.query.timestamp) + 1_000)
    const { payload, signature } = signedParts(second!)
    expect(signature).toBe(createHmac('sha256', FAKE_API_SECRET).update(payload).digest('hex'))
  })

  it('modo -2015: error 401 tipado, reconocido como clave rechazada y sin reintentos', async () => {
    fake.rejectKey()
    const err = await client().leverageBrackets().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceHttpError)
    expect(err).toMatchObject({ status: 401, code: -2015 })
    expect(isKeyRejected(err)).toBe(true)
    expect(requestsTo(BRACKETS)).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('una firma con otro secret es -1022', async () => {
    const err = await client({ apiSecret: 'otro-secreto-falso' }).commissionRate('BTCUSDT').catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 400, code: -1022 })
    expect(isKeyRejected(err)).toBe(true)
  })

  it('sin clave completa no firma ni llama a Binance', async () => {
    for (const rest of [client({ apiKey: null }), client({ apiSecret: null }), client({ apiKey: null, apiSecret: null })]) {
      expect(rest.hasKey()).toBe(false)
      await expect(rest.commissionRate('BTCUSDT')).rejects.toThrow(/clave/)
    }
    expect(client().hasKey()).toBe(true)
    expect(fake.requests).toHaveLength(0)
  })

  it('pesa 1 la hora, 1 leverageBracket y 20 commissionRate', async () => {
    const acquire = vi.spyOn(limiter, 'acquire')
    const rest = client()
    await rest.leverageBrackets()
    await rest.commissionRate('BTCUSDT')
    expect(acquire.mock.calls).toEqual([
      ['weight', 1],
      ['weight', 1],
      ['weight', 20],
    ])
  })

  it('un error de red no deja la firma en el mensaje ni en la causa', async () => {
    const leaky: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes(TIME)) return Response.json({ serverTime: now() })
      throw new Error(`no pude conectar con ${url}`)
    }
    const err = await client({ fetch: leaky, maxRetries: 0 }).commissionRate('BTCUSDT').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceNetworkError)
    const texts = [(err as Error).message, ((err as Error).cause as Error).message]
    for (const text of texts) {
      expect(text).not.toMatch(/signature=[0-9a-f]{64}/)
      expect(text).not.toContain(FAKE_API_SECRET)
    }
    expect(texts[1]).toContain('signature=[redactada]')
  })
})
