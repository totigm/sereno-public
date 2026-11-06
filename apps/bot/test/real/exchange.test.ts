import { OrderRejectedError } from '@sereno/core/src/exchange/errors'
import type { StopOrder } from '@sereno/core/src/exchange/types'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import type { PositionState } from '@sereno/core/src/exchange/types'
import { adapterFor, drive, realRig, REAL_T0, type RealRig } from '../helpers/real'

const WAIT = { timeout: 3_000, interval: 5 }
const SOL = 'SOLUSDT'
const UNKNOWN_ERROR = { code: -1000, msg: 'Unknown error, please check your request or try again later.' }

const stopFor = (stopPrice: number, qty: number): StopOrder => ({ symbol: SOL, side: 'sell', stopPrice, qty, reduceOnly: true })
const tick = (markPrice: number, at = REAL_T0, lastPrice = markPrice) => ({ symbol: SOL, markPrice, lastPrice, at, fundingRate: null, nextFundingTime: null })

describe('BinanceFuturesExchange contra el Binance falso', () => {
  let fake: FakeBinance
  let r: RealRig

  const posts = (path: string) => fake.requests.filter((q) => q.method === 'POST' && q.path === path)
  const deletes = (path: string) => fake.requests.filter((q) => q.method === 'DELETE' && q.path === path)

  async function mark(price: number, symbol = SOL): Promise<void> {
    fake.trading.setMark(symbol, price)
    r.exchange.setPrices(symbol, { mark: price, last: price })
  }

  async function openSol(qty: number, leverage = 3): Promise<void> {
    await r.exchange.setLeverage(SOL, leverage)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty })
  }

  // Un adaptador sobre una cuenta que se cree sin user data stream (el socket sigue: el test
  // retiene sus eventos con `holdUserEvents`).
  function withoutStream(): RealRig['exchange'] {
    const down = new Proxy(r.account, { get: (target, prop) => (prop === 'streamUp' ? false : Reflect.get(target, prop, target)) })
    const exchange = adapterFor({ ...r, account: down })
    exchange.setPrices(SOL, { mark: 150, last: 150 })
    return exchange
  }

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(async () => {
    fake.reset()
    fake.trading.setMark(SOL, 150)
    r = await realRig(fake)
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
  })
  afterEach(async () => {
    r.exchange.detach()
    await r.account.stop()
  })

  it('abre aislado con el apalancamiento del plan y deja stop y TP algorítmicos', async () => {
    await r.exchange.setLeverage(SOL, 3)
    expect(fake.trading.marginType(SOL)).toBe('isolated')
    expect(fake.trading.leverage(SOL)).toBe(3)

    const fill = await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    expect(fill).toMatchObject({ symbol: SOL, side: 'buy', qty: 2, price: 150, reported: true, spreadCost: 0 })
    expect(fake.trading.orders[0]!.clientOrderId).toMatch(/^sereno-0a1b2c3d-o/)
    expect(await r.exchange.getPositions()).toMatchObject([{ symbol: SOL, side: 'long', qty: 2, entryPrice: 150, leverage: 3, notional: 300, margin: 100 }])

    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    const tpId = await r.exchange.placeTakeProfitMarket({ ...stopFor(160, 2) })
    expect(stopId).toMatch(/^sereno-0a1b2c3d-s/)
    expect(tpId).toMatch(/^sereno-0a1b2c3d-t/)
    const sent = fake.trading.algos.map((a) => [a.clientAlgoId, a.orderType, a.side, a.triggerPrice, a.quantity, a.reduceOnly, a.workingType, a.closePosition, a.priceProtect])
    expect(sent).toEqual([
      [stopId, 'STOP_MARKET', 'SELL', '145.00', '2', true, 'MARK_PRICE', false, false],
      [tpId, 'TAKE_PROFIT_MARKET', 'SELL', '160.00', '2', true, 'MARK_PRICE', false, false],
    ])
    expect(r.exchange.lastStop(SOL)).toEqual({ price: 145, qty: 2 })
    await vi.waitFor(async () => expect((await r.exchange.getOpenOrders(SOL)).map((o) => [o.id, o.type, o.side, o.stopPrice])).toEqual([[stopId, 'STOP_MARKET', 'sell', 145], [tpId, 'TAKE_PROFIT_MARKET', 'sell', 160]]), WAIT)
  })

  it('con la operación apagada no toca Binance', async () => {
    r.gate.value = { allowed: false, detail: 'la operación con plata real está apagada: sólo cuido las abiertas' }
    const before = fake.requests.length
    const error = await r.exchange.setLeverage(SOL, 3).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OrderRejectedError)
    expect(error).toMatchObject({ reason: 'opening_disabled', detail: 'la operación con plata real está apagada: sólo cuido las abiertas' })
    await expect(r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })).rejects.toMatchObject({ reason: 'opening_disabled' })
    expect(fake.requests.length).toBe(before)
    expect(fake.trading.orders).toEqual([])
  })

  it('no abre donde Toti tiene posición', async () => {
    fake.trading.manualPosition(SOL, 3)
    await vi.waitFor(() => expect(r.account.position(SOL)).not.toBeNull(), WAIT)
    const before = fake.requests.length
    for (let i = 0; i < 2; i++) {
      await expect(r.exchange.setLeverage(SOL, 3)).rejects.toMatchObject({ reason: 'foreign_position', detail: 'tenés una posición tuya en SOL; no la toco' })
    }
    expect(fake.requests.length).toBe(before)
    // Se avisa una vez por racha, no con cada intento.
    expect(r.notes).toEqual([{ kind: 'foreign_position', symbol: SOL, phrase: 'tenés una posición tuya en SOL; no la toco', data: { amount: 3 } }])
  })

  it('sin user data stream pregunta por REST antes de abrir: no toca una posición de Toti que la cuenta todavía no vio', async () => {
    // La de Toti ya es aislada: Binance no rechaza fijarle el margen y sí le cambiaría el apalancamiento.
    await r.kit.trade.setIsolated(SOL)
    fake.holdUserEvents(true)
    fake.trading.manualPosition(SOL, 3)
    const leverage = fake.trading.leverage(SOL)
    const exchange = withoutStream()
    try {
      await expect(exchange.setLeverage(SOL, 3)).rejects.toMatchObject({ reason: 'foreign_position', detail: 'tenés una posición tuya en SOL; no la toco' })
      expect(posts('/fapi/v1/leverage')).toEqual([])
      expect(fake.trading.leverage(SOL)).toBe(leverage)
      expect(fake.trading.position(SOL)?.amount).toBe(3)
      expect(r.notes).toEqual([{ kind: 'foreign_position', symbol: SOL, phrase: 'tenés una posición tuya en SOL; no la toco', data: { amount: 3 } }])
    } finally {
      exchange.detach()
      fake.holdUserEvents(false)
    }
  })

  it('con el user data stream conectado no agrega el pedido por REST al abrir', async () => {
    await openSol(1)
    expect(fake.requests.filter((q) => q.path === '/fapi/v2/positionRisk')).toHaveLength(1)
  })

  it('fill parcial: la posición es lo ejecutado', async () => {
    fake.trading.partialFillNext(0.5)
    await r.exchange.setLeverage(SOL, 3)
    const fill = await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 4 })
    expect(fill.qty).toBe(2)
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    expect(await r.exchange.getPositions()).toMatchObject([{ qty: 2, notional: 300, margin: 100 }])
  })

  it('una apertura que Binance no ejecuta es un rechazo', async () => {
    fake.trading.partialFillNext(0.1)
    await r.exchange.setLeverage(SOL, 3)
    await expect(r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 4 })).rejects.toMatchObject({ reason: 'exchange_rejected' })
    expect(await r.exchange.getPositions()).toEqual([])
  })

  it('cierre parcial se completa en el próximo intento con fill agregado', async () => {
    await openSol(4)
    await mark(155)
    const start = await r.exchange.getBalance()
    fake.trading.partialFillNext(0.5)
    await expect(r.exchange.closePosition(SOL, 'signal_flip')).rejects.toThrow(/cerré 2 de 4/)
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    // Hasta completar, la billetera de la sesión no se mueve: el motor mide el cierre entero.
    expect((await r.exchange.getBalance()).total).toBe(start.total)

    await mark(156)
    const fill = await r.exchange.closePosition(SOL, 'signal_flip')
    const closes = fake.trading.trades.slice(1)
    expect(fill).toMatchObject({ side: 'sell', qty: 4, reported: true })
    expect(fill.price).toBeCloseTo(155.5, 10)
    expect(fill.fee).toBeCloseTo(closes.reduce((s, t) => s + Number(t.commission), 0), 10)
    expect(fake.trading.position(SOL)).toBeNull()
    const realized = closes.reduce((s, t) => s + Number(t.realizedPnl) - Number(t.commission), 0)
    expect((await r.exchange.getBalance()).total - start.total).toBeCloseTo(realized, 10)
    expect(await r.exchange.getPositions()).toEqual([])
  })

  // El cierre `c` llena 2 de 4 y el stop cierra los otros 2: lo que cerró el bot cuenta.
  async function halfClosedThenStopped(): Promise<{ start: number }> {
    await openSol(4)
    await r.exchange.placeStopMarket(stopFor(145, 4))
    await mark(146)
    const start = (await r.exchange.getBalance()).total
    fake.trading.partialFillNext(0.5)
    await expect(r.exchange.closePosition(SOL, 'signal_flip')).rejects.toThrow(/cerré 2 de 4/)
    await mark(144)
    expect(fake.trading.position(SOL)).toBeNull()
    await vi.waitFor(() => expect(r.exchange.hasPendingClose(SOL)).toBe(true), WAIT)
    return { start }
  }

  const closingTrades = () => fake.trading.trades.slice(1)
  const sumOf = (field: 'commission' | 'realizedPnl') => closingTrades().reduce((s, t) => s + Number(t[field]), 0)

  it('un cierre a medias que termina el stop llega al motor entero con el próximo tick', async () => {
    const { start } = await halfClosedThenStopped()
    const [triggered] = r.exchange.processTick(tick(144))
    expect(closingTrades()).toHaveLength(2)
    expect(triggered).toMatchObject({ reason: 'stop', triggerPrice: 145, fill: { qty: 4, reported: true } })
    expect(triggered!.fill.price).toBeCloseTo(145, 10)
    expect(triggered!.fill.fee).toBeCloseTo(sumOf('commission'), 10)
    expect(triggered!.pnlGross).toBeCloseTo(sumOf('realizedPnl'), 10)
    expect(triggered!.realized).toBeCloseTo(sumOf('realizedPnl') - sumOf('commission'), 10)
    expect((await r.exchange.getBalance()).total - start).toBeCloseTo(sumOf('realizedPnl') - sumOf('commission'), 10)
    // La cantidad cierra: no es una diferencia.
    expect(r.notes.filter((n) => n.kind === 'mismatch')).toEqual([])
  })

  it('un cierre a medias que termina el stop, pedido con closePosition, devuelve todo lo cerrado', async () => {
    const { start } = await halfClosedThenStopped()
    const fill = await r.exchange.closePosition(SOL, 'signal_flip')
    expect(fill).toMatchObject({ side: 'sell', qty: 4, reported: true })
    expect(fill.fee).toBeCloseTo(sumOf('commission'), 10)
    expect((await r.exchange.getBalance()).total - start).toBeCloseTo(sumOf('realizedPnl') - sumOf('commission'), 10)
    expect(r.exchange.processTick(tick(144))).toEqual([])
  })

  // Ids de las órdenes `c` que salieron, en orden.
  const closeIds = () => posts('/fapi/v1/order').flatMap((q) => (q.query.newClientOrderId?.includes('-c') ? [q.query.newClientOrderId] : []))

  it('un cierre que Binance no ejecutó (−1001) sale otra vez con otro id y la posición se cierra', async () => {
    await openSol(2)
    fake.trading.rejectNext('/fapi/v1/order', -1001)
    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'close_all'))
    expect(fill).toMatchObject({ side: 'sell', qty: 2, reported: true })
    expect(fake.trading.position(SOL)).toBeNull()
    const ids = closeIds()
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(await r.exchange.getPositions()).toEqual([])
  })

  it('un cierre que Binance sigue frenando (−1008) sale a lo sumo tres veces, cada una con su id, y la posición queda con su stop', async () => {
    await openSol(2)
    await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.trading.rejectNext('/fapi/v1/order', -1008, undefined, 4)
    const started = r.clock.now()
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'close_all'))).rejects.toMatchObject({ code: -1008 })
    const ids = closeIds()
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // Con las esperas de la política: en el acto, a los 500 ms y a los 1.500 ms más.
    expect(r.clock.now() - started).toBeGreaterThanOrEqual(2_000)
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    expect(fake.trading.algos.filter((a) => a.algoStatus === 'NEW').map((a) => a.orderType)).toEqual(['STOP_MARKET'])
  })

  it('un cierre de resultado desconocido no sale otra vez: queda en duda', async () => {
    await openSol(2)
    fake.trading.executeLateNext()
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'close_all'))).rejects.toThrow(/no entró/)
    expect(closeIds()).toHaveLength(1)
  })

  it('un cierre en duda se vuelve a consultar antes de mandar otro', async () => {
    r = { ...r, exchange: adapterFor(r, { retry: { delaysMs: [0], fillTimeoutMs: 1_000 } }) }
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await openSol(2)
    fake.failNext('/fapi/v1/order', { method: 'POST', status: 500, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } })
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))).rejects.toThrow(/no entró/)
    const doubtful = posts('/fapi/v1/order').at(-1)!.query.newClientOrderId!
    expect(doubtful).toMatch(/^sereno-0a1b2c3d-c/)
    // Binance la registra tarde.
    fake.trading.placeMarket({ symbol: SOL, side: 'SELL', qty: 2, reduceOnly: true, clientOrderId: doubtful })
    const sent = posts('/fapi/v1/order').length

    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))
    expect(fill).toMatchObject({ qty: 2, reported: true })
    // No mandó una segunda orden de cierre.
    expect(posts('/fapi/v1/order')).toHaveLength(sent)
    expect(await r.exchange.getPositions()).toEqual([])
  })

  it('un cierre cuyo fill no se pudo leer se vuelve a consultar antes de mandar otro, aunque Toti haya sumado', async () => {
    r = { ...r, exchange: adapterFor(r, { retry: { delaysMs: [0], fillTimeoutMs: 1_000 } }) }
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await openSol(2)
    fake.trading.manualPosition(SOL, 1)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(3), WAIT)
    // La orden queda en duda y la consulta por id falla cada vez (la del envío y las tres de la lectura).
    fake.failNext('/fapi/v1/order', { method: 'POST', status: 500, body: UNKNOWN_ERROR })
    fake.failNext('/fapi/v1/order', { method: 'GET', status: 500, body: UNKNOWN_ERROR }, 4)
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))).rejects.toMatchObject({ status: 500 })
    const doubtful = posts('/fapi/v1/order').at(-1)!.query.newClientOrderId!
    expect(doubtful).toMatch(/^sereno-0a1b2c3d-c/)
    // Binance la registra tarde.
    fake.trading.placeMarket({ symbol: SOL, side: 'SELL', qty: 2, reduceOnly: true, clientOrderId: doubtful })
    const sent = posts('/fapi/v1/order').length

    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))
    expect(fill).toMatchObject({ qty: 2, reported: true })
    // No salió otra orden de cierre: lo de Toti sigue entero.
    expect(posts('/fapi/v1/order')).toHaveLength(sent)
    expect(fake.trading.position(SOL)!.amount).toBe(1)
  })

  it('apertura confirmada sin poder leer el fill: la posición es del bot con lo que dijo Binance al mandarla', async () => {
    await r.exchange.setLeverage(SOL, 3)
    fake.holdUserEvents(true)
    fake.failNext('/fapi/v1/order', { method: 'GET', status: 500, body: UNKNOWN_ERROR }, 3)
    const fill = await drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))
    const opening = fake.trading.trades[0]!
    expect(fill).toMatchObject({ symbol: SOL, side: 'buy', qty: 2, price: 150, reported: true })
    // La comisión sale de los trades: no queda corta.
    expect(fill.fee).toBeCloseTo(Number(opening.commission), 10)
    expect(fake.requests.filter((q) => q.method === 'GET' && q.path === '/fapi/v1/order')).toHaveLength(3)
    expect(await r.exchange.getPositions()).toMatchObject([{ symbol: SOL, side: 'long', qty: 2, entryPrice: 150 }])
    expect(r.notes).toEqual([])
    // Y se protege como cualquier otra.
    await expect(r.exchange.placeStopMarket(stopFor(145, 2))).resolves.toMatch(/^sereno-0a1b2c3d-s/)
    fake.holdUserEvents(false)
  })

  it('apertura confirmada sin fill ni trades legibles: estima la comisión y lo avisa', async () => {
    await r.exchange.setLeverage(SOL, 3)
    fake.holdUserEvents(true)
    fake.failNext('/fapi/v1/order', { method: 'GET', status: 500, body: UNKNOWN_ERROR }, 3)
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 500, body: UNKNOWN_ERROR })
    const fill = await drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))
    expect(fill).toMatchObject({ qty: 2, price: 150 })
    expect(fill.fee).toBeCloseTo(2 * 150 * DEFAULT_SETTINGS.risk.takerFeeRate, 10)
    expect(r.notes.map((n) => [n.kind, n.phrase])).toEqual([['mismatch', expect.stringMatching(/estimé la comisión/)]])
    expect(await r.exchange.getPositions()).toMatchObject([{ symbol: SOL, qty: 2 }])
    fake.holdUserEvents(false)
  })

  // Una apertura que quedó en duda: Binance no la tenía al consultar.
  async function doubtfulOpen(): Promise<string> {
    r = { ...r, exchange: adapterFor(r, { retry: { delaysMs: [0], fillTimeoutMs: 1_000 } }) }
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    fake.failNext('/fapi/v1/order', { method: 'POST', status: 500, body: UNKNOWN_ERROR })
    await expect(drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))).rejects.toMatchObject({ reason: 'exchange_rejected' })
    expect(fake.trading.orders).toEqual([])
    return posts('/fapi/v1/order').at(-1)!.query.newClientOrderId!
  }

  it('una apertura en duda que Binance llena tarde se cierra en el acto antes de volver a abrir', async () => {
    const doubtful = await doubtfulOpen()
    expect(doubtful).toMatch(/^sereno-0a1b2c3d-o/)
    // Mientras no se sepa, no abre otra.
    await expect(drive(r.clock, r.exchange.setLeverage(SOL, 3))).rejects.toMatchObject({ reason: 'exchange_rejected' })
    expect(posts('/fapi/v1/order').at(-1)!.query.newClientOrderId).toBe(doubtful)

    // Binance la registra tarde: es una posición del bot (lo dice su id) que nada protege.
    fake.trading.placeMarket({ symbol: SOL, side: 'BUY', qty: 2, reduceOnly: false, clientOrderId: doubtful })
    await vi.waitFor(() => expect(r.account.position(SOL)).not.toBeNull(), WAIT)
    await expect(drive(r.clock, r.exchange.setLeverage(SOL, 3))).rejects.toMatchObject({ reason: 'exchange_rejected' })
    expect(posts('/fapi/v1/order').at(-1)!.query).toMatchObject({ side: 'SELL', quantity: '2', reduceOnly: 'true', type: 'MARKET', newClientOrderId: expect.stringMatching(/^sereno-0a1b2c3d-c/) })
    expect(fake.trading.position(SOL)).toBeNull()
    expect(r.notes.map((n) => n.kind)).not.toContain('foreign_position')
    expect(r.notes.find((n) => n.kind === 'unprotected')).toMatchObject({ symbol: SOL, phrase: 'Una apertura en SOL quedó en duda y Binance la llenó: la cerré para no dejarla sin protección.' })
    // Es plata de la sesión que el motor nunca vio: no entra a su billetera.
    expect((await r.exchange.getBalance()).total).toBe(1_000)
    expect(await r.exchange.getPositions()).toEqual([])

    // Resuelta, la moneda vuelve a estar libre.
    await vi.waitFor(() => expect(r.account.position(SOL)).toBeNull(), WAIT)
    await r.exchange.setLeverage(SOL, 3)
    await expect(drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))).resolves.toMatchObject({ qty: 2 })
  })

  it('una apertura en duda que Binance nunca registró se olvida pasado el plazo', async () => {
    await doubtfulOpen()
    await r.clock.advance(2 * 60_000)
    await drive(r.clock, r.exchange.setLeverage(SOL, 3))
    await expect(drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))).resolves.toMatchObject({ qty: 2 })
    expect(r.notes.map((n) => n.kind)).not.toContain('unprotected')
  })

  it('cierre pedido con el stop ya disparado devuelve el fill del stop', async () => {
    await openSol(2)
    await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.holdUserEvents(true)
    await mark(144)
    expect(fake.trading.position(SOL)).toBeNull()

    // La marca cruzó el stop: el cierre espera su disparo en vez de mandar una orden.
    const closing = r.exchange.closePosition(SOL, 'stop')
    await new Promise((resolve) => setTimeout(resolve, 20))
    fake.holdUserEvents(false)
    const fill = await closing

    const stopTrade = fake.trading.trades.at(-1)!
    expect(fill).toMatchObject({ side: 'sell', qty: 2, price: 144, reported: true })
    expect(fill.fee).toBeCloseTo(Number(stopTrade.commission), 10)
    // Un solo cierre en Binance: el del stop. No salió ninguna orden `c`.
    expect(fake.trading.trades).toHaveLength(2)
    expect(posts('/fapi/v1/order')).toHaveLength(1)
    // El motor no lo vuelve a recibir con el próximo tick.
    expect(r.exchange.processTick(tick(144))).toEqual([])
  })

  it('con la marca del bot atrasada, un stop que ya disparó sin avisar se busca antes de cerrar: sin Toti la orden de más no ejecuta nada', async () => {
    await openSol(2)
    await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.holdUserEvents(true)
    // Binance ya vio la marca bajo el stop; el bot todavía no.
    fake.trading.setMark(SOL, 144)
    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'close_all'))
    expect(fill).toMatchObject({ qty: 2, price: 144 })
    // La orden `c` sale (sin Toti es inofensiva: −2022) y el cierre es el del stop.
    expect(fake.trading.orders.filter((o) => o.clientOrderId.includes('-c') && Number(o.executedQty) > 0)).toEqual([])
    fake.holdUserEvents(false)
  })

  // El bot tiene 2 con stop en 145 y Toti suma 1: la moneda tiene 3.
  async function sharedWithToti(): Promise<string> {
    await openSol(2)
    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.trading.manualPosition(SOL, 1)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(3), WAIT)
    fake.holdUserEvents(true)
    return stopId
  }

  it('con Toti en la moneda, un cierre con la marca cruzada espera el disparo del stop y no toca lo de Toti', async () => {
    await sharedWithToti()
    await mark(144)
    expect(fake.trading.position(SOL)!.amount).toBe(1)
    const closing = r.exchange.closePosition(SOL, 'stop')
    await new Promise((resolve) => setTimeout(resolve, 20))
    fake.holdUserEvents(false)
    expect(await closing).toMatchObject({ qty: 2, price: 144, reported: true })
    expect(posts('/fapi/v1/order')).toHaveLength(1)
    expect(fake.trading.position(SOL)!.amount).toBe(1)
  })

  it('con Toti en la moneda y el evento del stop perdido, lo encuentra por REST y no manda la orden', async () => {
    const stopId = await sharedWithToti()
    await mark(144)
    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'stop'))
    expect(fill).toMatchObject({ qty: 2, price: 144, reported: true })
    expect(fake.requests.some((q) => q.method === 'GET' && q.path === '/fapi/v1/algoOrder' && q.query.clientAlgoId === stopId)).toBe(true)
    expect(posts('/fapi/v1/order')).toHaveLength(1)
    expect(fake.trading.position(SOL)!.amount).toBe(1)
    fake.holdUserEvents(false)
  })

  it('con Toti en la moneda, un cierre todo con la marca del bot atrasada pregunta por los stops antes de mandar nada', async () => {
    await sharedWithToti()
    // Binance ya disparó el stop; la marca del bot sigue en 150.
    fake.trading.setMark(SOL, 144)
    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'close_all'))
    expect(fill).toMatchObject({ qty: 2, price: 144, reported: true })
    expect(posts('/fapi/v1/order')).toHaveLength(1)
    expect(fake.trading.position(SOL)!.amount).toBe(1)
    fake.holdUserEvents(false)
  })

  // Sin stream la cuenta no ve lo que Toti suma ni el disparo: muestra sólo la cantidad del bot.
  // Con 1 de Toti queda 1 tras el disparo; con 2, lo mismo que tenía el bot.
  it.each([1, 2])('sin user data stream, con %d de Toti sumado y el stop disparado sin que el bot lo sepa, el cierre no toca lo de Toti', async (toti) => {
    const exchange = withoutStream()
    try {
      await exchange.setLeverage(SOL, 3)
      await exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
      const stopId = await exchange.placeStopMarket(stopFor(145, 2))
      fake.holdUserEvents(true)
      fake.trading.manualPosition(SOL, toti)
      // Binance dispara el stop; la marca del bot sigue en 150.
      fake.trading.setMark(SOL, 144)
      expect(r.account.position(SOL)!.amount).toBe(2)
      expect(fake.trading.position(SOL)!.amount).toBe(toti)

      const fill = await drive(r.clock, exchange.closePosition(SOL, 'close_all'))
      expect(fill).toMatchObject({ qty: 2, price: 144, reported: true })
      expect(fake.requests.some((q) => q.method === 'GET' && q.path === '/fapi/v1/algoOrder' && q.query.clientAlgoId === stopId)).toBe(true)
      expect(closeIds()).toEqual([])
      expect(fake.trading.position(SOL)!.amount).toBe(toti)
    } finally {
      exchange.detach()
      fake.holdUserEvents(false)
    }
  })

  it('sin user data stream y sin disparo, pregunta por los stops y cierra sólo lo del bot', async () => {
    const exchange = withoutStream()
    try {
      await exchange.setLeverage(SOL, 3)
      await exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
      const stopId = await exchange.placeStopMarket(stopFor(145, 2))
      fake.holdUserEvents(true)
      fake.trading.manualPosition(SOL, 2)

      const fill = await drive(r.clock, exchange.closePosition(SOL, 'close_all'))
      expect(fill).toMatchObject({ qty: 2, price: 150, reported: true })
      expect(fake.requests.some((q) => q.method === 'GET' && q.path === '/fapi/v1/algoOrder' && q.query.clientAlgoId === stopId)).toBe(true)
      expect(closeIds()).toHaveLength(1)
      expect(fake.trading.position(SOL)!.amount).toBe(2)
    } finally {
      exchange.detach()
      fake.holdUserEvents(false)
    }
  })

  it('cierre pedido con el stop disparado y el evento perdido: lo encuentra por REST', async () => {
    r = { ...r, exchange: adapterFor(r, { retry: { delaysMs: [0], fillTimeoutMs: 1_000 } }) }
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await openSol(2)
    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.holdUserEvents(true)
    await mark(144)
    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'stop'))
    expect(fill).toMatchObject({ qty: 2, price: 144, reported: true })
    expect(fake.requests.some((q) => q.method === 'GET' && q.path === '/fapi/v1/algoOrder' && q.query.clientAlgoId === stopId)).toBe(true)
  })

  it('con cantidad distinta cierra sólo la del bot', async () => {
    await openSol(1)
    await r.exchange.placeStopMarket(stopFor(145, 1))
    fake.trading.manualPosition(SOL, 2)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(3), WAIT)
    await r.exchange.placeTakeProfitMarket(stopFor(160, 1))

    await r.exchange.closePosition(SOL, 'signal_flip')
    expect(posts('/fapi/v1/order').at(-1)!.query).toMatchObject({ side: 'SELL', quantity: '1', reduceOnly: 'true', type: 'MARKET' })
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    expect(fake.trading.algos.map((a) => a.quantity)).toEqual(['1', '1'])
    // Los hermanos del cierre se cancelan: a Toti no le queda ningún stop del bot.
    await vi.waitFor(() => expect(fake.trading.algos.map((a) => a.algoStatus)).toEqual(['CANCELED', 'CANCELED']), WAIT)
  })

  // El bot tiene 4 con stop y take profit, Toti suma 2 y el cierre `c` llena la mitad.
  async function halfClosedWithToti(): Promise<{ oldStop: string; oldTp: string }> {
    await openSol(4)
    const oldStop = await r.exchange.placeStopMarket(stopFor(145, 4))
    const oldTp = await r.exchange.placeTakeProfitMarket(stopFor(160, 4))
    fake.trading.manualPosition(SOL, 2)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(6), WAIT)
    fake.trading.partialFillNext(0.5)
    return { oldStop, oldTp }
  }

  it('después de un cierre a medias, stop y take profit pasan a lo que le queda al bot', async () => {
    const { oldStop, oldTp } = await halfClosedWithToti()
    const before = fake.trading.events.length
    await expect(r.exchange.closePosition(SOL, 'signal_flip')).rejects.toThrow(/cerré 2 de 4/)
    const live = fake.trading.algos.filter((a) => a.algoStatus === 'NEW')
    expect(live.map((a) => [a.orderType, a.triggerPrice, a.quantity, a.reduceOnly, a.workingType])).toEqual([
      ['STOP_MARKET', '145.00', '2', true, 'MARK_PRICE'],
      ['TAKE_PROFIT_MARKET', '160.00', '2', true, 'MARK_PRICE'],
    ])
    // Cada uno nuevo antes de cancelar el viejo.
    const name = (id: string) => (id === oldStop ? 'stop viejo' : id === oldTp ? 'tp viejo' : id.includes('-s') ? 'stop nuevo' : 'tp nuevo')
    const algoEvents = fake.trading.events.slice(before).flatMap((e) => (e.e === 'ALGO_UPDATE' ? [`${name(e.o.caid)}:${e.o.X}`] : []))
    expect(algoEvents).toEqual(['stop nuevo:NEW', 'stop viejo:CANCELED', 'tp nuevo:NEW', 'tp viejo:CANCELED'])
    expect(r.exchange.lastStop(SOL)).toEqual({ price: 145, qty: 2 })
    // El motor mueve el stop con su cantidad entera: va lo que le queda al bot.
    await r.exchange.placeStopMarket(stopFor(147, 4))
    expect(fake.trading.algos.filter((a) => a.algoStatus === 'NEW' && a.orderType === 'STOP_MARKET').map((a) => [a.triggerPrice, a.quantity])).toEqual([['147.00', '2']])
  })

  it('si no pudo achicar el stop y dispara sobre lo de Toti, avisa que cerró de más', async () => {
    await halfClosedWithToti()
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1001, undefined, 6)
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))).rejects.toThrow(/cerré 2 de 4/)
    expect(fake.trading.algos.filter((a) => a.algoStatus === 'NEW').map((a) => [a.orderType, a.quantity])).toEqual([
      ['STOP_MARKET', '4'],
      ['TAKE_PROFIT_MARKET', '4'],
    ])
    await mark(144)
    await vi.waitFor(() => expect(r.exchange.hasPendingClose(SOL)).toBe(true), WAIT)
    const [triggered] = r.exchange.processTick(tick(144))
    expect(triggered!.fill.qty).toBe(6)
    expect(r.notes.filter((n) => n.kind === 'mismatch')).toEqual([{ kind: 'mismatch', symbol: SOL, phrase: 'El stop de SOL cerró 6, más que los 4 míos: la diferencia era tuya.', data: { filled: 6, botQty: 4 } }])
  })

  it('stop imposible: cierra a mercado y avisa unprotected', async () => {
    await openSol(2)
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1001, undefined, 3)
    const started = r.clock.now()
    await expect(drive(r.clock, r.exchange.placeStopMarket(stopFor(145, 2)))).rejects.toMatchObject({ code: -1001 })
    // Tres intentos: en el acto, a los 500 ms y a los 1.500 ms más.
    expect(posts('/fapi/v1/algoOrder')).toHaveLength(3)
    expect(r.clock.now() - started).toBeGreaterThanOrEqual(2_000)
    expect(fake.trading.position(SOL)).toBeNull()
    expect(r.notes.map((n) => n.kind)).toEqual(['rejected', 'unprotected'])
    expect(r.notes[1]).toMatchObject({ symbol: SOL, phrase: 'No pude poner el stop en SOL: la cerré para no dejarla sin protección.' })

    // El take profit ya no tiene sentido; el motor recibe el cierre con el próximo tick.
    await expect(r.exchange.placeTakeProfitMarket(stopFor(160, 2))).rejects.toThrow(/ya se cerró/)
    const [triggered] = r.exchange.processTick(tick(150))
    const close = fake.trading.trades.at(-1)!
    expect(triggered).toMatchObject({ symbol: SOL, reason: 'unprotected', triggerPrice: 145, fill: { qty: 2, price: 150, reported: true } })
    expect(triggered!.orderId).toMatch(/^sereno-0a1b2c3d-c/)
    expect(triggered!.realized).toBeCloseTo(Number(close.realizedPnl) - Number(close.commission), 10)
    expect(await r.exchange.getPositions()).toEqual([])
  })

  it('stop imposible con el take profit ya disparado: no manda la orden `c` y el motor recibe el take profit', async () => {
    await openSol(2)
    const tpId = await r.exchange.placeTakeProfitMarket(stopFor(160, 2))
    fake.holdUserEvents(true)
    // La marca cruzó el take profit y Binance cerró la posición; el evento no llegó.
    await mark(161)
    expect(fake.trading.position(SOL)).toBeNull()
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1001, undefined, 3)
    await expect(drive(r.clock, r.exchange.placeStopMarket(stopFor(145, 2)))).rejects.toMatchObject({ code: -1001 })

    expect(closeIds()).toEqual([])
    expect(r.exchange.hasPendingClose(SOL)).toBe(true)
    expect(r.notes.map((n) => n.kind)).toEqual(['rejected'])
    const [triggered] = r.exchange.processTick(tick(161))
    expect(triggered).toMatchObject({ symbol: SOL, reason: 'take_profit', orderId: tpId, triggerPrice: 160, fill: { qty: 2, price: 161, reported: true } })
    expect(await r.exchange.getPositions()).toEqual([])
    fake.holdUserEvents(false)
  })

  it('si mover el stop falla, el viejo sigue cubriendo: no cierra', async () => {
    await openSol(2)
    const old = await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1001, undefined, 3)
    await expect(drive(r.clock, r.exchange.placeStopMarket(stopFor(148, 2)))).rejects.toMatchObject({ code: -1001 })
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    expect(fake.trading.algos.filter((a) => a.algoStatus === 'NEW').map((a) => a.clientAlgoId)).toEqual([old])
    expect(r.notes.map((n) => n.kind)).toEqual(['rejected'])
    expect(r.exchange.lastStop(SOL)).toEqual({ price: 145, qty: 2 })
  })

  it('un stop igual que cancelaron a mano no se reutiliza', async () => {
    await openSol(2)
    const placed = await r.exchange.placeStopMarket(stopFor(145, 2))
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toHaveLength(1), WAIT)
    fake.trading.cancelAlgo({ clientAlgoId: placed })
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toEqual([]), WAIT)
    const again = await r.exchange.placeStopMarket(stopFor(145, 2))
    expect(again).not.toBe(placed)
    expect(fake.trading.algos.filter((a) => a.algoStatus === 'NEW').map((a) => [a.clientAlgoId, a.triggerPrice, a.quantity])).toEqual([[again, '145.00', '2']])
  })

  it('un stop igual recién puesto se reutiliza aunque el stream no lo haya avisado', async () => {
    await openSol(2)
    fake.holdUserEvents(true)
    const placed = await r.exchange.placeStopMarket(stopFor(145, 2))
    expect(await r.exchange.placeStopMarket(stopFor(145, 2))).toBe(placed)
    expect(posts('/fapi/v1/algoOrder')).toHaveLength(1)
    fake.holdUserEvents(false)
  })

  it('un stop que dispararía en el acto tira enseguida y no cierra', async () => {
    await openSol(2)
    await mark(144)
    await expect(r.exchange.placeStopMarket(stopFor(145, 2))).rejects.toMatchObject({ code: -2021 })
    expect(posts('/fapi/v1/algoOrder')).toHaveLength(1)
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    expect(r.notes.map((n) => n.kind)).toEqual(['rejected'])
  })

  it('placeStopMarket reutiliza un stop igual ya puesto', async () => {
    await openSol(2)
    const placed = await r.exchange.placeStopMarket(stopFor(145, 2))
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toHaveLength(1), WAIT)
    // Otro adaptador sobre la misma cuenta, como después de reiniciar.
    const state = (await r.exchange.getPositions())[0]!
    r.exchange.detach()
    r = { ...r, exchange: adapterFor(r) }
    r.exchange.restorePosition(state)
    expect(await r.exchange.placeStopMarket(stopFor(145, 2))).toBe(placed)
    expect(fake.trading.algos).toHaveLength(1)
    expect(r.exchange.lastStop(SOL)).toEqual({ price: 145, qty: 2 })
  })

  it('un stop de antes de reiniciar con otro precio se cancela después de poner el nuevo', async () => {
    await openSol(2)
    const old = await r.exchange.placeStopMarket(stopFor(145, 2))
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toHaveLength(1), WAIT)
    const state = (await r.exchange.getPositions())[0]!
    r.exchange.detach()
    r = { ...r, exchange: adapterFor(r) }
    r.exchange.restorePosition(state)
    const placed = await r.exchange.placeStopMarket(stopFor(146, 2))
    expect(placed).not.toBe(old)
    const algoEvents = fake.trading.events.flatMap((e) => (e.e === 'ALGO_UPDATE' ? [`${e.o.caid === old ? 'viejo' : 'nuevo'}:${e.o.X}`] : []))
    expect(algoEvents).toEqual(['viejo:NEW', 'nuevo:NEW', 'viejo:CANCELED'])
  })

  it('mover el stop pone el nuevo antes de cancelar el viejo, sin pedidos de más', async () => {
    await openSol(2)
    const old = await r.exchange.placeStopMarket(stopFor(145, 2))
    const moved = await r.exchange.placeStopMarket(stopFor(148, 2))
    // El motor cancela el viejo después: ya estaba cancelado.
    await r.exchange.cancelOrder(SOL, old)
    const algoEvents = fake.trading.events.flatMap((e) => (e.e === 'ALGO_UPDATE' ? [`${e.o.caid === old ? 'viejo' : e.o.caid === moved ? 'nuevo' : '?'}:${e.o.X}`] : []))
    expect(algoEvents).toEqual(['viejo:NEW', 'nuevo:NEW', 'viejo:CANCELED'])
    expect(deletes('/fapi/v1/algoOrder')).toHaveLength(1)
    expect(r.exchange.lastStop(SOL)).toEqual({ price: 148, qty: 2 })
  })

  it('cancelar un algo que ya no existe es éxito', async () => {
    await openSol(2)
    await expect(r.exchange.cancelOrder(SOL, 'sereno-0a1b2c3d-s1')).resolves.toBeUndefined()
  })

  it('una cancelación que Binance no toma se reintenta con espera', async () => {
    await openSol(2)
    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.failNext('/fapi/v1/algoOrder', { method: 'DELETE', status: 503, body: { code: -1008, msg: 'Request throttled by system-level protection.' } })
    await expect(r.exchange.cancelOrder(SOL, stopId)).rejects.toMatchObject({ code: -1008 })
    // El próximo tick del motor vuelve a pedirlo: todavía no es su turno y no se pide.
    await expect(r.exchange.cancelOrder(SOL, stopId)).rejects.toThrow(/reintento en 1 s/)
    expect(deletes('/fapi/v1/algoOrder')).toHaveLength(1)
    await r.clock.advance(1_000)
    await r.exchange.cancelOrder(SOL, stopId)
    expect(deletes('/fapi/v1/algoOrder')).toHaveLength(2)
    expect(fake.trading.algos[0]!.algoStatus).toBe('CANCELED')
  })

  it('los números del fill son los de Binance', async () => {
    await r.exchange.setLeverage(SOL, 3)
    // El último precio al mandar era 149,90 y Binance llenó a 150: 0,10 de más por unidad.
    r.exchange.setPrices(SOL, { mark: 150, last: 149.9 })
    const open = await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    const opening = fake.trading.trades[0]!
    expect(open).toMatchObject({ price: Number(opening.price), qty: 2, fee: Number(opening.commission), reported: true, spreadCost: 0 })
    expect(open.slippageCost).toBeCloseTo(0.2, 10)

    await mark(152)
    const before = await r.exchange.getBalance()
    const close = await r.exchange.closePosition(SOL, 'take_profit')
    const closing = fake.trading.trades[1]!
    expect(close).toMatchObject({ price: 152, qty: 2, fee: Number(closing.commission), reported: true })
    const after = await r.exchange.getBalance()
    expect(after.total - before.total).toBeCloseTo(Number(closing.realizedPnl) - Number(closing.commission), 10)
    expect(Number(closing.realizedPnl)).toBeCloseTo(4, 10)
  })

  it('un disparo del stop llega al motor con el próximo tick, con los números de Binance', async () => {
    await openSol(2)
    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    await r.exchange.placeTakeProfitMarket(stopFor(160, 2))
    await mark(144)
    await vi.waitFor(() => expect(r.exchange.hasPendingClose(SOL)).toBe(true), WAIT)
    const [triggered] = r.exchange.processTick(tick(144))
    const stopTrade = fake.trading.trades.at(-1)!
    expect(triggered).toMatchObject({ symbol: SOL, reason: 'stop', orderId: stopId, triggerPrice: 145, markPrice: 144, shortfall: 0, liquidationFeeRate: null, fill: { qty: 2, price: 144, reported: true } })
    expect(triggered!.pnlGross).toBeCloseTo(Number(stopTrade.realizedPnl), 10)
    expect(triggered!.realized).toBeCloseTo(Number(stopTrade.realizedPnl) - Number(stopTrade.commission), 10)
    // El take profit hermano se cancela.
    await vi.waitFor(() => expect(fake.trading.algos.map((a) => a.algoStatus)).toEqual(['FINISHED', 'CANCELED']), WAIT)
  })

  it('una liquidación llega sin orden y con la tasa de liquidación del contrato', async () => {
    await openSol(2, 10)
    await r.exchange.placeStopMarket(stopFor(140, 2))
    fake.trading.liquidate(SOL)
    await vi.waitFor(() => expect(r.exchange.hasPendingClose(SOL)).toBe(true), WAIT)
    const [triggered] = r.exchange.processTick(tick(136))
    const state = (await r.exchange.getPositions())[0]
    expect(state).toBeUndefined()
    expect(triggered).toMatchObject({ reason: 'liquidation', orderId: null, liquidationFeeRate: 0.0125 })
  })

  it('un 503 de resultado desconocido consulta por el id y no vuelve a mandar la apertura: queda en duda', async () => {
    await r.exchange.setLeverage(SOL, 3)
    fake.failNext('/fapi/v1/order', { method: 'POST', status: 503, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } })
    await expect(drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))).rejects.toMatchObject({ reason: 'exchange_rejected', detail: 'Binance no confirmó la orden' })
    expect(fake.trading.orders).toEqual([])
    // Preguntó por el mismo id (al mandarla y al leer el fill) y no la mandó otra vez.
    const id = posts('/fapi/v1/order')[0]!.query.newClientOrderId!
    expect(fake.requests.filter((q) => q.path === '/fapi/v1/order').map((q) => `${q.method}:${q.query.newClientOrderId ?? q.query.origClientOrderId}`)).toEqual([`POST:${id}`, `GET:${id}`, `GET:${id}`])
  })

  it('una respuesta cortada con la orden adentro no la duplica', async () => {
    await r.exchange.setLeverage(SOL, 3)
    fake.trading.dropResponseNext('/fapi/v1/order')
    const fill = await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    expect(fill.qty).toBe(2)
    expect(fake.trading.orders).toHaveLength(1)
  })

  // Binance documenta −1007 como "execution status unknown": la orden puede ejecutarse después
  // de que la consulta por id dijo que no existía. Un filled MARKET ya no es una orden abierta,
  // así que mandarla otra vez con el mismo id no se rechaza como duplicada.
  it('una apertura que vence sin respuesta y Binance ejecuta tarde no sale dos veces', async () => {
    await r.exchange.setLeverage(SOL, 3)
    fake.trading.executeLateNext()
    await expect(drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))).rejects.toMatchObject({ reason: 'exchange_rejected' })
    expect(posts('/fapi/v1/order')).toHaveLength(1)

    const [late] = fake.trading.executeLate()
    expect(fake.trading.position(SOL)!.amount).toBe(2)
    await vi.waitFor(() => expect(r.account.position(SOL)).not.toBeNull(), WAIT)
    // La apertura en duda se resuelve antes de volver a abrir: es del bot (su id) y se cierra.
    await expect(drive(r.clock, r.exchange.setLeverage(SOL, 3))).rejects.toMatchObject({ reason: 'exchange_rejected' })
    const sent = posts('/fapi/v1/order').map((q) => [q.query.newClientOrderId, q.query.side, q.query.quantity])
    expect(sent).toEqual([
      [late!.clientOrderId, 'BUY', '2'],
      [expect.stringMatching(/^sereno-0a1b2c3d-c/), 'SELL', '2'],
    ])
    expect(fake.trading.position(SOL)).toBeNull()
  })

  it('un cierre que vence sin respuesta y Binance ejecuta tarde no se lleva lo de Toti', async () => {
    await openSol(2)
    fake.trading.manualPosition(SOL, 1)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(3), WAIT)
    fake.trading.executeLateNext()
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))).rejects.toThrow(/no entró/)
    const sent = posts('/fapi/v1/order').length

    fake.trading.executeLate()
    expect(fake.trading.position(SOL)!.amount).toBe(1)
    // El próximo intento encuentra la orden en duda llena: no manda otra.
    const fill = await drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))
    expect(fill).toMatchObject({ qty: 2, reported: true })
    expect(posts('/fapi/v1/order')).toHaveLength(sent)
    expect(fake.trading.position(SOL)!.amount).toBe(1)
  })

  it('un rechazo al fijar el apalancamiento sale como exchange_rejected y se avisa', async () => {
    fake.trading.rejectNext('/fapi/v1/leverage', -4028, 'Leverage 30 is not valid')
    await expect(r.exchange.setLeverage(SOL, 30)).rejects.toMatchObject({ reason: 'exchange_rejected', detail: 'Binance rechazó el pedido (código −4028)' })
    expect(r.notes).toEqual([{ kind: 'rejected', symbol: SOL, phrase: 'Binance rechazó el pedido (código −4028)', data: { code: -4028, order: 'leverage' } }])
  })

  it('sin margen en la sesión no manda la orden', async () => {
    r = { ...r, exchange: adapterFor(r, { initialBalance: 50 }) }
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await expect(r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })).rejects.toMatchObject({ reason: 'insufficient_margin' })
    expect(posts('/fapi/v1/order')).toEqual([])
  })

  it('un error fatal de Binance se avisa y tira', async () => {
    await r.exchange.setLeverage(SOL, 3)
    fake.trading.rejectNext('/fapi/v1/order', -2015, 'Invalid API-key, IP, or permissions for action.')
    const error = await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(OrderRejectedError)
    expect((error as Error).message).toBe('Binance rechaza la clave: inválida, IP no autorizada o sin permiso')
    expect(r.notes).toEqual([{ kind: 'fatal', symbol: SOL, phrase: 'Binance rechaza la clave: inválida, IP no autorizada o sin permiso', data: { code: -2015 } }])
  })

  it('restaurar con otra cantidad en Binance avisa la diferencia y toma la liquidación de Binance', async () => {
    fake.trading.setMarginType(SOL, 'isolated')
    fake.trading.setLeverage(SOL, 3)
    fake.trading.manualPosition(SOL, 3)
    // Primero el evento del stream y después la foto REST, que trae la liquidación.
    await vi.waitFor(() => expect(r.account.position(SOL)).not.toBeNull(), WAIT)
    await r.account.sync()
    const binanceLiquidation = r.account.position(SOL)!.liquidationPrice!
    const state: PositionState = { symbol: SOL, side: 'long', leverage: 3, margin: 100, notional: 300, qty: 2, entryPrice: 150, openedAt: REAL_T0, liquidationPrice: 101, feesPaid: 0.15, fundingPaid: 0 }
    const restored = r.exchange.restorePosition(state)
    expect(restored.liquidationRecalculated).toEqual({ from: 101, to: binanceLiquidation })
    expect(r.notes).toEqual([{ kind: 'mismatch', symbol: SOL, phrase: 'Binance tiene 3 SOL y yo 2: manejo sólo lo mío y no abro más ahí hasta que quede en cero.', data: { binanceAmount: 3, botQty: 2 } }])
  })

  it('applyFunding entrega lo que informó Binance para esa moneda, una vez', async () => {
    await openSol(2)
    const applied = { symbol: SOL, side: 'long' as const, qty: 2, rate: 0.0001, markPrice: 150, amount: -0.03, at: REAL_T0 }
    r.exchange.queueFunding(applied)
    const before = (await r.exchange.getBalance()).total
    const ev = { symbol: SOL, at: REAL_T0, rate: 0.0002, markPrice: 151 }
    expect(r.exchange.applyFunding({ ...ev, symbol: 'ETHUSDT' })).toEqual([])
    expect(r.exchange.applyFunding(ev)).toEqual([applied])
    expect(r.exchange.applyFunding(ev)).toEqual([])
    expect((await r.exchange.getBalance()).total - before).toBeCloseTo(-0.03, 12)
    expect((await r.exchange.getPositions())[0]!.fundingPaid).toBeCloseTo(0.03, 12)
    expect(() => r.exchange.applyFunding({ ...ev, rate: Number.NaN })).toThrow(RangeError)
  })

  it('ensureProtected repone el último stop si lo cancelaron a mano', async () => {
    await openSol(2)
    const placed = await r.exchange.placeStopMarket(stopFor(145, 2))
    expect(await r.exchange.ensureProtected(SOL)).toBeNull()
    fake.trading.cancelAlgo({ clientAlgoId: placed })
    expect(await r.exchange.ensureProtected(SOL)).toBe('replaced')
    const live = fake.trading.algos.filter((a) => a.algoStatus === 'NEW')
    expect(live.map((a) => [a.orderType, a.triggerPrice, a.quantity])).toEqual([['STOP_MARKET', '145.00', '2']])
  })

  it('cancelAllBot cancela todo lo del bot y nada de Toti', async () => {
    await openSol(2)
    await r.exchange.placeStopMarket(stopFor(145, 2))
    await r.exchange.placeTakeProfitMarket(stopFor(160, 2))
    await r.kit.trade.algoOrder({ symbol: SOL, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '140.00', quantity: '1', clientAlgoId: 'manual_1' })
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toHaveLength(2), WAIT)
    await r.exchange.cancelAllBot()
    expect(fake.trading.algos.map((a) => [a.clientAlgoId.startsWith('sereno-') ? 'bot' : 'toti', a.algoStatus])).toEqual([
      ['bot', 'CANCELED'],
      ['bot', 'CANCELED'],
      ['toti', 'NEW'],
    ])
  })
})
