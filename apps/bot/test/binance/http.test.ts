import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../../src/binance/errors'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { BinanceHttp, type BinanceHttpOptions } from '../../src/binance/http'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BINANCE_LIMITS } from '../../src/config'

interface Call {
  method: string
  url: URL
  apiKey: string | null
}

// `fetch` de mentira: contesta lo que diga el guion para cada pedido, en orden.
function scriptedFetch(calls: Call[], answers: ((call: Call) => Response | Promise<Response>)[]): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    const call = { method: init?.method ?? 'GET', url: new URL(String(input)), apiKey: headers.get('X-MBX-APIKEY') }
    calls.push(call)
    if (call.url.pathname === '/fapi/v1/time') return Response.json({ serverTime: Date.now() })
    const answer = answers.shift()
    if (!answer) throw new Error(`sin respuesta guionada para ${call.method} ${call.url.pathname}`)
    return answer(call)
  }
}

const ok = (): Response => Response.json({ ok: true })
const binanceError = (status: number, code: number, msg = 'error'): (() => Response) => () => Response.json({ code, msg }, { status })

describe('BinanceHttp', () => {
  let calls: Call[]
  let sleeps: number[]
  let limiter: RateLimiter

  const http = (answers: ((call: Call) => Response | Promise<Response>)[], opts: Partial<BinanceHttpOptions> = {}): BinanceHttp =>
    new BinanceHttp({
      baseUrl: 'https://fapi.example',
      limiter,
      apiKey: FAKE_API_KEY,
      apiSecret: FAKE_API_SECRET,
      maxRetries: 3,
      fetch: scriptedFetch(calls, answers),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      ...opts,
    })

  const toPath = (path: string): Call[] => calls.filter((c) => c.url.pathname === path)

  beforeEach(() => {
    calls = []
    sleeps = []
    limiter = new RateLimiter(BINANCE_LIMITS)
  })

  it('un POST firmado viaja con método, clave, recvWindow, timestamp y la firma al final', async () => {
    await http([ok]).request('/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', reduceOnly: true }, { kind: 'weight', weight: 1 }, { signed: true, method: 'POST' })
    const [post] = toPath('/fapi/v1/order')
    expect(post!.method).toBe('POST')
    expect(post!.apiKey).toBe(FAKE_API_KEY)
    const raw = post!.url.search.slice(1)
    const at = raw.lastIndexOf('&signature=')
    const payload = raw.slice(0, at)
    expect(payload).toMatch(/^symbol=BTCUSDT&side=BUY&reduceOnly=true&recvWindow=5000&timestamp=\d+$/)
    expect(raw.slice(at + '&signature='.length)).toBe(createHmac('sha256', FAKE_API_SECRET).update(payload).digest('hex'))
  })

  it("retry 'never': una caída de red se devuelve sin reintentar", async () => {
    const err = await http([() => Promise.reject(new TypeError('fetch failed'))])
      .request('/fapi/v1/order', {}, { kind: 'weight', weight: 1 }, { signed: true, method: 'POST', retry: 'never' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceNetworkError)
    expect(toPath('/fapi/v1/order')).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it("retry 'never': un 5xx se devuelve sin reintentar", async () => {
    const err = await http([binanceError(503, -1000, 'Unknown error, please check your request or try again later.')])
      .request('/fapi/v1/order', {}, { kind: 'weight', weight: 1 }, { signed: true, method: 'POST', retry: 'never' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceHttpError)
    expect(err).toMatchObject({ status: 503, code: -1000 })
    expect(toPath('/fapi/v1/order')).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it("retry 'never': un 429 se devuelve sin reintentar, pero frena el limitador", async () => {
    const t = 1_000_000
    limiter = new RateLimiter({ ...BINANCE_LIMITS, now: () => t })
    const hold = vi.spyOn(limiter, 'holdUntil')
    const answer = (): Response => Response.json({ code: -1003, msg: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '7' } })
    const err = await http([answer], { now: () => t })
      .request('/fapi/v1/order', {}, { kind: 'weight', weight: 1 }, { signed: true, method: 'POST', retry: 'never' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceRateLimited)
    expect(toPath('/fapi/v1/order')).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(hold).toHaveBeenCalledWith(t + 7_000)
  })

  it("retry 'never': un −1021 renueva el desfase y reintenta una vez (Binance no lo ejecutó)", async () => {
    await http([binanceError(400, -1021, 'Timestamp for this request is outside of the recvWindow.'), ok]).request(
      '/fapi/v1/order',
      {},
      { kind: 'weight', weight: 1 },
      { signed: true, method: 'POST', retry: 'never' },
    )
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /fapi/v1/time', 'POST /fapi/v1/order', 'GET /fapi/v1/time', 'POST /fapi/v1/order'])
  })

  it("retry 'safe' (el de siempre): reintenta un 5xx con espera", async () => {
    await http([binanceError(503, -1000), ok]).request('/fapi/v1/openAlgoOrders', {}, { kind: 'weight', weight: 1 }, { signed: true })
    expect(toPath('/fapi/v1/openAlgoOrders')).toHaveLength(2)
    expect(sleeps).toEqual([1_000])
  })

  it("prioridad 'high': el limitador la recibe, también para medir el desfase", async () => {
    const acquire = vi.spyOn(limiter, 'acquire')
    await http([ok]).request('/fapi/v1/order', {}, { kind: 'weight', weight: 1 }, { signed: true, method: 'POST', priority: 'high' })
    expect(acquire.mock.calls).toEqual([
      ['weight', 1, 'high'],
      ['weight', 1, 'high'],
    ])
  })

  it('un pedido sin firma pero con clave (USER_STREAM) lleva la clave y ninguna firma', async () => {
    await http([() => Response.json({ listenKey: 'k' })]).request('/fapi/v1/listenKey', {}, { kind: 'weight', weight: 1 }, { method: 'POST' })
    const [post] = toPath('/fapi/v1/listenKey')
    expect(post!.apiKey).toBe(FAKE_API_KEY)
    expect(post!.url.search).toBe('')
  })

  it('mide la hora en la ruta que se le indique (la de /sapi es otra)', async () => {
    const calls2: string[] = []
    const fetchSapi: typeof fetch = async (input) => {
      const url = new URL(String(input))
      calls2.push(url.pathname)
      return url.pathname === '/api/v3/time' ? Response.json({ serverTime: Date.now() }) : ok()
    }
    await http([], { fetch: fetchSapi, timePath: '/api/v3/time' }).request('/sapi/v1/account/apiRestrictions', {}, { kind: 'weight', weight: 1 }, { signed: true })
    expect(calls2).toEqual(['/api/v3/time', '/sapi/v1/account/apiRestrictions'])
  })
})
