import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceHttpError, BinanceNetworkError } from '../../src/binance/errors'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance, type RecordedRequest } from '../../src/binance/fake/server'
import { classifyBinanceError } from '../../src/binance/trade-errors'
import { createLogger } from '../../src/logger'
import { tradeFor, type TradeKit } from '../helpers/binance'
import { logSink } from '../helpers/log-sink'

const ORDER = '/fapi/v1/order'
const ALGO = '/fapi/v1/algoOrder'
const BOT = 'sereno-0a1b2c3d-'

describe('BinanceTradeRest contra el Binance falso', () => {
  let fake: FakeBinance
  let kit: TradeKit

  const requestsTo = (path: string, method?: string): RecordedRequest[] =>
    fake.requests.filter((r) => r.path === path && (method === undefined || r.method === method))
  const trail = (): string[] => fake.requests.filter((r) => r.path !== '/fapi/v1/time').map((r) => `${r.method} ${r.path}`)

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    fake.trading.setMark('BTCUSDT', 68_000)
    fake.trading.setMark('SOLUSDT', 150)
    kit = tradeFor(fake)
  })

  describe('órdenes de mercado', () => {
    it('abre a mercado con id de cliente, RESULT y sin reduceOnly, y devuelve el ack normalizado', async () => {
      const ack = await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      expect(ack).toMatchObject({ symbol: 'BTCUSDT', clientOrderId: `${BOT}o1`, status: 'FILLED', executedQty: 0.01, avgPrice: 68_000 })
      expect(ack.orderId).toBeGreaterThan(0)
      const [post] = requestsTo(ORDER, 'POST')
      expect(post!.query).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.010', newClientOrderId: `${BOT}o1`, newOrderRespType: 'RESULT' })
      expect(post!.query.reduceOnly).toBeUndefined()
      expect(fake.trading.position('BTCUSDT')).toMatchObject({ amount: 0.01, entryPrice: 68_000 })
    })

    it('cierra con reduceOnly=true', async () => {
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'SELL', quantity: '0.010', reduceOnly: true, clientOrderId: `${BOT}c1` })
      expect(requestsTo(ORDER, 'POST')[1]!.query.reduceOnly).toBe('true')
      expect(fake.trading.position('BTCUSDT')).toBeNull()
    })

    it('si la respuesta se corta, no duplica la orden', async () => {
      fake.trading.dropResponseNext(ORDER)
      const ack = await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      expect(ack).toMatchObject({ clientOrderId: `${BOT}o1`, status: 'FILLED', executedQty: 0.01 })
      expect(fake.trading.orders.filter((o) => o.clientOrderId === `${BOT}o1`)).toHaveLength(1)
      expect(trail()).toEqual([`POST ${ORDER}`, `GET ${ORDER}`])
      expect(fake.trading.position('BTCUSDT')).toMatchObject({ amount: 0.01 })
    })

    it('ante un 5xx en duda consulta por el id y no la vuelve a mandar', async () => {
      fake.failNext(ORDER, { method: 'POST', status: 503, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } })
      const err = await kit.trade
        .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BinanceHttpError)
      expect(classifyBinanceError(err).kind).toBe('retryable')
      expect(trail()).toEqual([`POST ${ORDER}`, `GET ${ORDER}`])
      expect(requestsTo(ORDER, 'GET')[0]!.query.origClientOrderId).toBe(`${BOT}o1`)
      expect(fake.trading.orders).toHaveLength(0)
    })

    it('una que vence sin respuesta y Binance ejecuta tarde sale una sola vez', async () => {
      fake.trading.executeLateNext()
      const err = await kit.trade
        .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
        .catch((e: unknown) => e)
      expect(classifyBinanceError(err)).toMatchObject({ kind: 'retryable', code: -1007 })
      expect(trail()).toEqual([`POST ${ORDER}`, `GET ${ORDER}`])
      fake.trading.executeLate()
      expect(fake.trading.position('BTCUSDT')).toMatchObject({ amount: 0.01 })
    })

    it('un rechazo de Binance no se consulta ni se reintenta', async () => {
      fake.trading.rejectNext(ORDER, -2019, 'Margin is insufficient.')
      const err = await kit.trade
        .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
        .catch((e: unknown) => e)
      expect(classifyBinanceError(err)).toMatchObject({ kind: 'rejected', code: -2019, message: 'Binance rechazó la orden: no alcanza el margen' })
      expect(trail()).toEqual([`POST ${ORDER}`])
    })

    it('una falla segura de Binance (−1001) vuelve a quien decide sin consultar', async () => {
      fake.trading.rejectNext(ORDER, -1001)
      const err = await kit.trade
        .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
        .catch((e: unknown) => e)
      expect(classifyBinanceError(err)).toMatchObject({ kind: 'retryable', code: -1001 })
      expect(trail()).toEqual([`POST ${ORDER}`])
    })

    it('el fill parcial deja en el ack lo ejecutado', async () => {
      fake.trading.partialFillNext(0.5)
      const ack = await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      expect(ack).toMatchObject({ status: 'EXPIRED', executedQty: 0.005 })
      expect(fake.trading.position('BTCUSDT')).toMatchObject({ amount: 0.005 })
    })

    it('queryOrder devuelve null si la orden no existe', async () => {
      await expect(kit.trade.queryOrder('BTCUSDT', `${BOT}nada`)).resolves.toBeNull()
    })

    it('queryOrderById encuentra la orden por el id de Binance (los trades no traen el de cliente)', async () => {
      const ack = await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      await expect(kit.trade.queryOrderById('BTCUSDT', ack.orderId)).resolves.toMatchObject({ clientOrderId: `${BOT}o1`, orderId: ack.orderId })
      await expect(kit.trade.queryOrderById('BTCUSDT', ack.orderId + 1_000)).resolves.toBeNull()
    })
  })

  describe('órdenes algorítmicas', () => {
    const stop = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '66000.0', quantity: '0.010', clientAlgoId: `${BOT}s1` } as const

    it('stop por la API algorítmica con reduceOnly, cantidad y MARK_PRICE', async () => {
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      const ack = await kit.trade.algoOrder(stop)
      expect(ack).toMatchObject({ symbol: 'BTCUSDT', clientAlgoId: `${BOT}s1`, type: 'STOP_MARKET', side: 'SELL', triggerPrice: 66_000, quantity: 0.01, status: 'NEW', actualOrderId: null })
      const [post] = requestsTo(ALGO, 'POST')
      expect(post!.query).toMatchObject({
        algoType: 'CONDITIONAL',
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        triggerPrice: '66000.0',
        quantity: '0.010',
        reduceOnly: 'true',
        workingType: 'MARK_PRICE',
        clientAlgoId: `${BOT}s1`,
      })
      expect(post!.query.closePosition).toBeUndefined()
      expect(post!.query.priceProtect).toBeUndefined()
      expect(requestsTo(ORDER, 'POST')).toHaveLength(1)
    })

    it('el take profit va por el mismo camino', async () => {
      await kit.trade.algoOrder({ ...stop, type: 'TAKE_PROFIT_MARKET', triggerPrice: '72000.0', clientAlgoId: `${BOT}t1` })
      expect(requestsTo(ALGO, 'POST')[0]!.query).toMatchObject({ type: 'TAKE_PROFIT_MARKET', reduceOnly: 'true', workingType: 'MARK_PRICE' })
    })

    it('si la respuesta del algo se corta, no duplica el stop', async () => {
      fake.trading.dropResponseNext(ALGO)
      const ack = await kit.trade.algoOrder(stop)
      expect(ack).toMatchObject({ clientAlgoId: `${BOT}s1`, status: 'NEW' })
      expect(trail()).toEqual([`POST ${ALGO}`, `GET ${ALGO}`])
      expect(fake.trading.algos.filter((a) => a.clientAlgoId === `${BOT}s1`)).toHaveLength(1)
    })

    it('ante 5xx consulta el algo antes de reintentar', async () => {
      fake.failNext(ALGO, { method: 'POST', status: 503 })
      await kit.trade.algoOrder(stop)
      expect(trail()).toEqual([`POST ${ALGO}`, `GET ${ALGO}`, `POST ${ALGO}`])
      expect(fake.trading.algos).toHaveLength(1)
    })

    it('openAlgoOrders lista las abiertas y queryAlgo devuelve null si no existe', async () => {
      await kit.trade.algoOrder(stop)
      await kit.trade.algoOrder({ ...stop, symbol: 'SOLUSDT', triggerPrice: '140.0000', quantity: '3', clientAlgoId: `${BOT}s2` })
      expect((await kit.trade.openAlgoOrders('BTCUSDT')).map((a) => a.clientAlgoId)).toEqual([`${BOT}s1`])
      expect((await kit.trade.openAlgoOrders()).map((a) => a.clientAlgoId).sort()).toEqual([`${BOT}s1`, `${BOT}s2`])
      await expect(kit.trade.queryAlgo(`${BOT}s1`)).resolves.toMatchObject({ status: 'NEW', triggerPrice: 66_000 })
      await expect(kit.trade.queryAlgo(`${BOT}nada`)).resolves.toBeNull()
    })

    it('cancelAlgo cancela y una inexistente cuenta como éxito', async () => {
      await kit.trade.algoOrder(stop)
      await kit.trade.cancelAlgo(`${BOT}s1`)
      expect(await kit.trade.openAlgoOrders('BTCUSDT')).toEqual([])
      await expect(kit.trade.cancelAlgo(`${BOT}s1`)).resolves.toBeUndefined()
      await expect(kit.trade.cancelAlgo(`${BOT}nunca`)).resolves.toBeUndefined()
      // Cancelar no lleva `symbol`: la documentación sólo acepta algoId o clientAlgoId.
      expect(requestsTo(ALGO, 'DELETE')[0]!.query.symbol).toBeUndefined()
    })

    it('el stop dispara por la marca y cierra a la marca con comisión y pnl realizado', async () => {
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      await kit.trade.algoOrder(stop)
      fake.trading.setMark('BTCUSDT', 65_900)
      expect(fake.trading.position('BTCUSDT')).toBeNull()
      const algo = await kit.trade.queryAlgo(`${BOT}s1`)
      expect(algo).toMatchObject({ status: 'FINISHED' })
      expect(algo!.actualOrderId).not.toBeNull()
      const trades = await kit.trade.userTrades('BTCUSDT', { orderId: algo!.actualOrderId! })
      expect(trades).toHaveLength(1)
      expect(trades[0]).toMatchObject({ side: 'SELL', price: 65_900, qty: 0.01, commissionAsset: 'USDT' })
      expect(trades[0]!.realizedPnl).toBeCloseTo(-21, 9)
      expect(trades[0]!.commission).toBeCloseTo(0.01 * 65_900 * 0.00045, 9)
    })
  })

  describe('configuración y cuenta', () => {
    it('setIsolated acepta −4046', async () => {
      await kit.trade.setIsolated('BTCUSDT')
      await expect(kit.trade.setIsolated('BTCUSDT')).resolves.toBeUndefined()
      const posts = requestsTo('/fapi/v1/marginType', 'POST')
      expect(posts).toHaveLength(2)
      expect(posts[0]!.query).toMatchObject({ symbol: 'BTCUSDT', marginType: 'ISOLATED' })
    })

    it('setLeverage fija el apalancamiento y positionRisk lo muestra con el margen aislado', async () => {
      await kit.trade.setIsolated('BTCUSDT')
      await kit.trade.setLeverage('BTCUSDT', 5)
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'SELL', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      const positions = await kit.trade.positionRisk()
      // Sólo las que tienen cantidad: el resto de los contratos no son posiciones.
      expect(positions.map((p) => p.symbol)).toEqual(['BTCUSDT'])
      expect(positions[0]).toMatchObject({ symbol: 'BTCUSDT', amount: -0.01, entryPrice: 68_000, markPrice: 68_000, marginType: 'isolated', leverage: 5 })
      expect(positions[0]!.isolatedMargin).toBeCloseTo((0.01 * 68_000) / 5, 6)
      expect(positions[0]!.liquidationPrice).toBeGreaterThan(68_000)
    })

    it('lee los modos de la cuenta, la billetera y la hora de Binance', async () => {
      fake.trading.config({ dualSide: true, multiAssets: true, feeBurn: true, wallet: 250, serverTimeOffsetMs: 2_000 })
      await expect(kit.trade.dualSide()).resolves.toBe(true)
      await expect(kit.trade.multiAssets()).resolves.toBe(true)
      await expect(kit.trade.feeBurn()).resolves.toBe(true)
      await expect(kit.trade.usdtBalance()).resolves.toEqual({ wallet: 250, available: 250 })
      const serverTime = await kit.trade.serverTime()
      expect(Math.abs(serverTime - (Date.now() + 2_000))).toBeLessThan(500)
    })

    it('el saldo disponible descuenta el margen en uso', async () => {
      fake.trading.config({ wallet: 100 })
      await kit.trade.setIsolated('SOLUSDT')
      await kit.trade.setLeverage('SOLUSDT', 10)
      await kit.trade.marketOrder({ symbol: 'SOLUSDT', side: 'BUY', quantity: '2', reduceOnly: false, clientOrderId: `${BOT}o1` })
      const fee = 2 * 150 * 0.00045
      const balance = await kit.trade.usdtBalance()
      expect(balance.wallet).toBeCloseTo(100 - fee, 9)
      expect(balance.available).toBeCloseTo(100 - fee - 30, 9)
    })

    it('apiRestrictions trae los permisos de la clave', async () => {
      fake.trading.config({ restrictions: { enableFutures: true, enableWithdrawals: false, ipRestrict: true } })
      await expect(kit.trade.apiRestrictions()).resolves.toEqual({ enableFutures: true, enableWithdrawals: false, ipRestrict: true })
      expect(requestsTo('/sapi/v1/account/apiRestrictions')).toHaveLength(1)
    })

    it('apiRestrictions null sin sapi', async () => {
      const testnet = tradeFor(fake, { sapi: false })
      await expect(testnet.trade.apiRestrictions()).resolves.toBeNull()
      expect(requestsTo('/sapi/v1/account/apiRestrictions')).toHaveLength(0)
    })

    it('con /sapi apagado en el falso (testnet), el pedido falla como en testnet', async () => {
      fake.sapiEnabled = false
      await expect(kit.trade.apiRestrictions()).rejects.toMatchObject({ status: 404 })
    })

    it('userTradesBetween trae todos los trades de un período largo y movido, en orden', async () => {
      const DAY = 24 * 3_600_000
      const start = Date.UTC(2026, 9, 1)
      // 2.500 trades en 10 días: más de una ventana de 7 días y más de una página de 1.000.
      const count = 2_500
      for (let i = 0; i < count; i++) {
        fake.trading.trades.push({ buyer: true, commission: '0.01', commissionAsset: 'USDT', id: i + 1, maker: false, orderId: i + 1, price: '150', qty: '1', quoteQty: '150', realizedPnl: '0', side: 'BUY', positionSide: 'BOTH', symbol: 'SOLUSDT', time: start + Math.floor((i * 10 * DAY) / count) })
      }
      const trades = await kit.trade.userTradesBetween('SOLUSDT', start, start + 10 * DAY)
      expect(trades.map((t) => t.id)).toEqual(Array.from({ length: count }, (_, i) => i + 1))
      for (const q of requestsTo('/fapi/v1/userTrades')) {
        expect(Number(q.query.endTime) - Number(q.query.startTime)).toBeLessThan(7 * DAY)
      }
      // Sólo los del período pedido.
      expect(await kit.trade.userTradesBetween('SOLUSDT', start + DAY, start + 2 * DAY - 1)).toHaveLength(250)
    })

    it('userTrades y fundingIncome normalizan lo que informa Binance', async () => {
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      const start = Date.now() - 1_000
      fake.trading.chargeFunding('BTCUSDT', 0.0001)
      const trades = await kit.trade.userTrades('BTCUSDT', { startTime: start })
      expect(trades).toHaveLength(1)
      expect(trades[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 68_000, realizedPnl: 0, commissionAsset: 'USDT' })
      const income = await kit.trade.fundingIncome(start)
      expect(income).toHaveLength(1)
      expect(income[0]!.symbol).toBe('BTCUSDT')
      expect(income[0]!.income).toBeCloseTo(-0.01 * 68_000 * 0.0001, 9)
      expect(income[0]!.tranId).toBeGreaterThan(0)
      expect(requestsTo('/fapi/v1/income')[0]!.query).toMatchObject({ incomeType: 'FUNDING_FEE', startTime: String(start) })
    })

    it('listenKey: crear, renovar y cerrar con la clave y sin firma', async () => {
      const key = await kit.trade.listenKeyCreate()
      expect(key).toMatch(/\w+/)
      await kit.trade.listenKeyKeepAlive()
      await kit.trade.listenKeyClose()
      const calls = requestsTo('/fapi/v1/listenKey')
      expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'DELETE'])
      for (const c of calls) {
        expect(c.apiKey).toBe(FAKE_API_KEY)
        expect(c.query.signature).toBeUndefined()
      }
    })

    it('todo pedido de órdenes va con prioridad alta', async () => {
      const acquire = vi.spyOn(kit.limiter, 'acquire')
      await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      await kit.trade.positionRisk()
      await kit.trade.openAlgoOrders()
      expect(acquire.mock.calls.length).toBeGreaterThan(0)
      for (const call of acquire.mock.calls) expect(call[2]).toBe('high')
      expect(acquire.mock.calls.slice(-2)).toEqual([
        ['weight', 5, 'high'],
        ['weight', 40, 'high'],
      ])
    })
  })

  describe('secretos', () => {
    it('ni la clave ni el secret ni la firma aparecen en errores ni logs', async () => {
      const sink = logSink()
      const logger = createLogger({ level: 'trace', destination: sink.stream })
      const errors: unknown[] = []

      fake.rejectKey()
      const rejected = tradeFor(fake, { logger })
      errors.push(await rejected.trade.positionRisk().catch((e: unknown) => e))
      errors.push(await rejected.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` }).catch((e: unknown) => e))

      // Red caída: un `fetch` que cita la URL entera (con la firma) en su error.
      const leaky: typeof fetch = async (input) => {
        const url = String(input)
        if (url.includes('/fapi/v1/time')) return Response.json({ serverTime: Date.now() })
        throw new Error(`no pude conectar con ${url}`)
      }
      const offline = tradeFor(fake, { logger, fetch: leaky })
      errors.push(await offline.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o2` }).catch((e: unknown) => e))
      errors.push(await offline.trade.algoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '66000.0', quantity: '0.010', clientAlgoId: `${BOT}s1` }).catch((e: unknown) => e))

      expect(classifyBinanceError(errors[0]).kind).toBe('fatal')
      expect(errors[2]).toBeInstanceOf(BinanceNetworkError)
      const texts = [...errors.map((e) => (e as Error).message), ...errors.map((e) => classifyBinanceError(e).message), JSON.stringify(sink.lines())]
      expect(sink.lines().length).toBeGreaterThan(0)
      for (const text of texts) {
        expect(text).not.toContain(FAKE_API_KEY)
        expect(text).not.toContain(FAKE_API_SECRET)
        expect(text).not.toContain('signature=')
      }
    })
  })
})

describe('el Binance falso hace cumplir las reglas de órdenes', () => {
  let fake: FakeBinance
  let kit: TradeKit

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    fake.trading.setMark('BTCUSDT', 68_000)
    kit = tradeFor(fake)
  })

  const send = (path: string, method: 'POST' | 'GET', params: Record<string, string>): Promise<unknown> =>
    kit.http.request(path, params, { kind: 'weight', weight: 1 }, { signed: true, method, retry: 'never' })

  it('un STOP_MARKET por /fapi/v1/order es −4120', async () => {
    const err = await send(ORDER, 'POST', { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: '66000', quantity: '0.010' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: -4120 })
  })

  it('closePosition=true en una algorítmica se rechaza', async () => {
    const err = await send(ALGO, 'POST', { algoType: 'CONDITIONAL', symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '66000', closePosition: 'true' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BinanceHttpError)
    expect(fake.trading.algos).toHaveLength(0)
  })

  it('un stop que dispararía en el acto es −2021', async () => {
    const err = await kit.trade
      .algoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '68500.0', quantity: '0.010', clientAlgoId: `${BOT}s1` })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: -2021 })
  })

  it('una cantidad fuera de la grilla es −1111', async () => {
    const err = await kit.trade
      .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.0105', reduceOnly: false, clientOrderId: `${BOT}o1` })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: -1111 })
  })

  it('reduceOnly sin posición es −2022', async () => {
    const err = await kit.trade
      .marketOrder({ symbol: 'BTCUSDT', side: 'SELL', quantity: '0.010', reduceOnly: true, clientOrderId: `${BOT}c1` })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: -2022 })
  })

  it('en modo cobertura toda orden sin positionSide es −4061', async () => {
    fake.trading.config({ dualSide: true })
    const err = await kit.trade
      .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: -4061 })
  })

  it('una firma inválida en un POST es −1022', async () => {
    const forged = tradeFor(fake, { apiSecret: 'otro-secreto-falso' })
    const err = await forged.trade
      .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: -1022 })
    expect(fake.trading.orders).toHaveLength(0)
  })

  it('manualPosition suma una posición de Toti sin id del bot', async () => {
    fake.trading.manualPosition('BTCUSDT', 0.02)
    const [position] = await kit.trade.positionRisk()
    expect(position).toMatchObject({ symbol: 'BTCUSDT', amount: 0.02 })
    const [trade] = await kit.trade.userTrades('BTCUSDT', {})
    const order = fake.trading.orders.find((o) => o.orderId === trade!.orderId)
    expect(order!.clientOrderId.startsWith('sereno-')).toBe(false)
  })

  it('emite los eventos del user data stream con los campos de Binance', async () => {
    await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
    await kit.trade.algoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '66000.0', quantity: '0.010', clientAlgoId: `${BOT}s1` })
    fake.trading.setMark('BTCUSDT', 65_000)
    const kinds = fake.trading.events.map((e) => (e.e === 'ALGO_UPDATE' ? `ALGO ${e.o.X}` : e.e === 'ORDER_TRADE_UPDATE' ? `ORDER ${e.o.x}/${e.o.X}` : e.e))
    expect(kinds).toEqual([
      'ORDER NEW/NEW',
      'ORDER TRADE/FILLED',
      'ACCOUNT_UPDATE',
      'ALGO NEW',
      'ALGO TRIGGERING',
      'ALGO TRIGGERED',
      'ORDER NEW/NEW',
      'ORDER TRADE/FILLED',
      'ACCOUNT_UPDATE',
      'ALGO FINISHED',
    ])
    const triggered = fake.trading.events.find((e) => e.e === 'ALGO_UPDATE' && e.o.X === 'TRIGGERED')
    const fill = fake.trading.events.filter((e) => e.e === 'ORDER_TRADE_UPDATE' && e.o.X === 'FILLED').at(-1)
    if (triggered?.e !== 'ALGO_UPDATE' || fill?.e !== 'ORDER_TRADE_UPDATE') throw new Error('faltan eventos')
    expect(triggered.o).toMatchObject({ caid: `${BOT}s1`, s: 'BTCUSDT', o: 'STOP_MARKET', tp: '66000.0', wt: 'MARK_PRICE', R: true, cp: false })
    expect(triggered.o.ai).toBe(String(fill.o.i))
    expect(fill.o).toMatchObject({ s: 'BTCUSDT', S: 'SELL', o: 'MARKET', ot: 'STOP_MARKET', R: true, N: 'USDT', ps: 'BOTH' })
  })
})
