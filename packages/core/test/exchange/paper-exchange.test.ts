import { describe, it, expect } from 'vitest'
import { OrderRejectedError } from '../../src/exchange/errors'
import { PaperExchange, type PaperExchangeOptions } from '../../src/exchange/paper-exchange'
import type { PositionState, StopOrder } from '../../src/exchange/types'
import type { FundingEvent, MarkTick } from '../../src/types'
import { btcLikeInfo, exampleSettings } from '../risk/fixtures'

const BTC = 'BTCUSDT'
const TAKER = 0.0005
const HALF_SPREAD = 0.0001
const SLIPPAGE = 0.0002
// Fill de compra a 100 con medio spread 0,01% y slippage 0,02% (brief).
const ENTRY = 100.03
const OPEN_FEE = ENTRY * TAKER // 0,050015
const MARGIN = ENTRY / 5

function makeExchange(overrides: Partial<PaperExchangeOptions> = {}): PaperExchange {
  return new PaperExchange({
    settings: exampleSettings().risk,
    infos: { [BTC]: btcLikeInfo() },
    clock: () => 1_000,
    initialBalance: 1_000,
    ...overrides,
  })
}

// Sin spread ni slippage: la entrada queda exactamente en el último precio.
function frictionlessExchange(initialBalance = 1_000): PaperExchange {
  return makeExchange({
    settings: exampleSettings({ risk: { slippageRate: 0 } }).risk,
    infos: { [BTC]: btcLikeInfo({ halfSpreadRate: 0 }) },
    initialBalance,
  })
}

async function open(ex: PaperExchange, side: 'buy' | 'sell', qty = 1, leverage = 5) {
  ex.setPrices(BTC, { mark: 100, last: 100 })
  await ex.setLeverage(BTC, leverage)
  return ex.placeMarketOrder({ symbol: BTC, side, qty })
}

const openLong = (ex: PaperExchange, qty = 1, leverage = 5) => open(ex, 'buy', qty, leverage)
const openShort = (ex: PaperExchange, qty = 1, leverage = 5) => open(ex, 'sell', qty, leverage)

function stop(stopPrice: number, side: 'buy' | 'sell' = 'sell'): StopOrder {
  return { symbol: BTC, side, stopPrice, closePosition: true }
}

function tick(mark: number, last = mark, at = 2_000): MarkTick {
  return { symbol: BTC, markPrice: mark, lastPrice: last, at, fundingRate: null, nextFundingTime: null }
}

function funding(rate: number, symbol = BTC): FundingEvent {
  return { symbol, at: 3_000, rate, markPrice: 101 }
}

// Fill de un stop/TP: último precio en contra por medio spread + 2 × slippage.
const stopFill = (last: number, dir: 1 | -1) => last * (1 + dir * (HALF_SPREAD + 2 * SLIPPAGE))

describe('PaperExchange — órdenes a mercado', () => {
  it('abre un long de 1 BTC a 100 ⇒ fill 100,03 y comisión taker sobre el nocional del fill', async () => {
    const ex = makeExchange()
    const fill = await openLong(ex)
    expect(fill.price).toBeCloseTo(ENTRY, 10)
    expect(fill.fee).toBeCloseTo(0.050015, 10)
    expect(fill).toMatchObject({ symbol: BTC, side: 'buy', qty: 1, at: 1_000 })
    expect(fill.spreadCost).toBeCloseTo(0.01, 10)
    expect(fill.slippageCost).toBeCloseTo(0.02, 10)

    const [pos] = await ex.getPositions()
    expect(pos).toMatchObject({ symbol: BTC, side: 'long', qty: 1, leverage: 5, openedAt: 1_000, fundingPaid: 0 })
    expect(pos?.entryPrice).toBeCloseTo(ENTRY, 10)
    expect(pos?.notional).toBeCloseTo(ENTRY, 10)
    expect(pos?.margin).toBeCloseTo(MARGIN, 10)
    expect(pos?.liquidationPrice).toBeCloseTo((ENTRY * 0.8) / 0.99, 10)
    expect(pos?.feesPaid).toBeCloseTo(OPEN_FEE, 10)

    const balance = await ex.getBalance()
    expect(balance.total).toBeCloseTo(1_000 - OPEN_FEE, 10)
    expect(balance.marginInUse).toBeCloseTo(MARGIN, 10)
    expect(balance.available).toBeCloseTo(1_000 - OPEN_FEE - MARGIN, 10)
  })

  it('cierra a 110 ⇒ pnlGross 9,937 (salida 109,967 − entrada 100,03) y dos comisiones', async () => {
    const ex = makeExchange()
    await openLong(ex)
    ex.setPrices(BTC, { mark: 110, last: 110 })
    const fill = await ex.closePosition(BTC, 'manual')
    // La salida también paga medio spread y slippage: 110 × (1 − 0,0003) = 109,967.
    const exit = 110 * (1 - HALF_SPREAD - SLIPPAGE)
    expect(fill.price).toBeCloseTo(exit, 10)
    expect(fill).toMatchObject({ side: 'sell', qty: 1, at: 1_000 })
    const closeFee = exit * TAKER
    expect(fill.fee).toBeCloseTo(closeFee, 10)

    // El pnl sale de los precios esperados, no del fill: el saldo prueba lo que realizó el simulador.
    const pnlGross = exit - ENTRY
    expect(pnlGross).toBeCloseTo(9.937, 10)
    const balance = await ex.getBalance()
    expect(balance.total).toBeCloseTo(1_000 + pnlGross - OPEN_FEE - closeFee, 10)
    expect(balance.marginInUse).toBe(0)
    expect(await ex.getPositions()).toEqual([])
  })

  it('reduceOnly parcial realiza la mitad del pnl y libera la mitad del margen', async () => {
    const ex = makeExchange()
    await openLong(ex, 1)
    ex.setPrices(BTC, { mark: 110, last: 110 })
    const fill = await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 0.5, reduceOnly: true })
    expect(fill.qty).toBe(0.5)
    const [pos] = await ex.getPositions()
    expect(pos?.qty).toBe(0.5)
    expect(pos?.margin).toBeCloseTo(MARGIN / 2, 10)
    expect(pos?.notional).toBeCloseTo(ENTRY / 2, 10)
    expect(pos?.entryPrice).toBeCloseTo(ENTRY, 10)
    const exit = 110 * (1 - HALF_SPREAD - SLIPPAGE)
    expect(pos?.feesPaid).toBeCloseTo(OPEN_FEE + exit * 0.5 * TAKER, 10)
    const balance = await ex.getBalance()
    expect(balance.total).toBeCloseTo(1_000 - OPEN_FEE + (exit - ENTRY) * 0.5 - exit * 0.5 * TAKER, 10)
  })

  it('una venta sin reduceOnly del tamaño de la posición la cierra (one-way mode)', async () => {
    const ex = makeExchange()
    await openLong(ex, 0.3)
    await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 0.1 })
    // 0,3 − 0,1 en coma flotante es 0,1999…: la cantidad queda en la grilla del step.
    expect((await ex.getPositions())[0]?.qty).toBe(0.2)
    await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 0.2 })
    expect(await ex.getPositions()).toEqual([])
  })

  it('reduceOnly recorta la cantidad a la posición y no la invierte', async () => {
    const ex = makeExchange()
    await openLong(ex, 1)
    const fill = await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 2, reduceOnly: true })
    expect(fill.qty).toBe(1)
    expect(await ex.getPositions()).toEqual([])
  })

  it('un cierre parcial normal no marca nada en el fill', async () => {
    const ex = makeExchange()
    await openLong(ex, 1)
    const fill = await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 0.5, reduceOnly: true })
    expect(fill.remainderClosed).toBeUndefined()
  })

  it('un parcial que dejaría un resto por debajo del minNotional cierra la posición entera', async () => {
    const ex = makeExchange()
    await openLong(ex, 1)
    ex.setPrices(BTC, { mark: 110, last: 110 })
    // Quedarían 0,04 × 110 = 4,4 USDT, menos que el minNotional de 5.
    const fill = await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 0.96, reduceOnly: true })
    expect(fill).toMatchObject({ qty: 1, remainderClosed: true })
    const exit = 110 * (1 - HALF_SPREAD - SLIPPAGE)
    expect(fill.fee).toBeCloseTo(exit * TAKER, 10)
    expect(await ex.getPositions()).toEqual([])
    expect((await ex.getBalance()).total).toBeCloseTo(1_000 - OPEN_FEE + (exit - ENTRY) - exit * TAKER, 10)
  })

  it('un parcial que dejaría un resto por debajo del minQty cierra la posición entera', async () => {
    const ex = makeExchange({ infos: { [BTC]: btcLikeInfo({ minQty: 0.01, minNotional: 0.1 }) } })
    await openLong(ex, 1)
    await ex.placeStopMarket(stop(95))
    const fill = await ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 0.995 })
    expect(fill).toMatchObject({ qty: 1, remainderClosed: true })
    expect(await ex.getPositions()).toEqual([])
    expect(await ex.getOpenOrders()).toEqual([])
  })

  it('rechaza órdenes inválidas: símbolo, cantidad, precios, apalancamiento, mínimos y saldo', async () => {
    const ex = makeExchange()
    await expect(ex.placeMarketOrder({ symbol: 'NOPEUSDT', side: 'buy', qty: 1 })).rejects.toThrow(/desconocido/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 0 })).rejects.toThrow(/cantidad/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: Number.NaN })).rejects.toThrow(/cantidad/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 0.0015 })).rejects.toThrow(/stepSize/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 1 })).rejects.toThrow(/precios/)
    ex.setPrices(BTC, { mark: 100, last: 100 })
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 1 })).rejects.toThrow(/apalancamiento/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 1, reduceOnly: true })).rejects.toThrow(/reduceOnly/)
    await ex.setLeverage(BTC, 5)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 0.01 })).rejects.toThrow(/minNotional/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 100 })).rejects.toThrow(/insuficiente/)
    expect(await ex.getPositions()).toEqual([])
    expect((await ex.getBalance()).total).toBe(1_000)
  })

  it('el mínimo de nocional y el saldo son rechazos de la orden (OrderRejectedError con su motivo); el resto, errores', async () => {
    const ex = makeExchange()
    ex.setPrices(BTC, { mark: 100, last: 100 })
    await ex.setLeverage(BTC, 5)
    const reasonOf = (qty: number) => ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty }).then(() => null, (e: unknown) => (e instanceof OrderRejectedError ? e.reason : 'otro error'))
    expect(await reasonOf(0.01)).toBe('min_notional')
    expect(await reasonOf(100)).toBe('insufficient_margin')
    expect(await reasonOf(0.0015)).toBe('otro error')
  })

  it('una posición por símbolo: no suma, no invierte y no cambia el apalancamiento abierta', async () => {
    const ex = makeExchange()
    await openLong(ex)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 1 })).rejects.toThrow(/ya hay una posición/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'buy', qty: 1, reduceOnly: true })).rejects.toThrow(/reduceOnly/)
    await expect(ex.placeMarketOrder({ symbol: BTC, side: 'sell', qty: 2 })).rejects.toThrow(/invertir/)
    await expect(ex.setLeverage(BTC, 3)).rejects.toThrow(/posición abierta/)
    expect((await ex.getPositions())[0]?.qty).toBe(1)
  })

  it('setLeverage valida símbolo y valor', async () => {
    const ex = makeExchange()
    await expect(ex.setLeverage('NOPEUSDT', 5)).rejects.toThrow(/desconocido/)
    await expect(ex.setLeverage(BTC, 0)).rejects.toThrow(/apalancamiento/)
    await expect(ex.setLeverage(BTC, 2.5)).rejects.toThrow(/apalancamiento/)
  })

  it('ids de órdenes deterministas: un contador por simulador', async () => {
    const a = makeExchange()
    const b = makeExchange()
    await openLong(a)
    await openLong(b)
    const stopA = await a.placeStopMarket(stop(95))
    const stopB = await b.placeStopMarket(stop(95))
    expect(stopA).toBe(stopB)
    const tpA = await a.placeTakeProfitMarket(stop(105))
    expect(tpA).not.toBe(stopA)
    expect(await b.placeTakeProfitMarket(stop(105))).toBe(tpA)
  })
})

describe('PaperExchange — stop, take profit y cancelaciones', () => {
  it('stop en 95: tick con marca 94,9 dispara y llena a last − (medio spread + 2 × slippage)', async () => {
    const ex = makeExchange()
    await openLong(ex)
    const stopId = await ex.placeStopMarket(stop(95))
    expect(ex.processTick(tick(95.1))).toEqual([])

    const triggered = ex.processTick(tick(94.9, 94.95))
    expect(triggered).toHaveLength(1)
    const [t] = triggered
    expect(t).toMatchObject({ symbol: BTC, reason: 'stop', orderId: stopId, triggerPrice: 95, markPrice: 94.9, shortfall: 0, liquidationFeeRate: null })
    const exit = stopFill(94.95, -1)
    expect(t?.fill).toMatchObject({ side: 'sell', qty: 1, at: 2_000 })
    expect(t?.fill.price).toBeCloseTo(exit, 10)
    expect(t?.fill.fee).toBeCloseTo(exit * TAKER, 10)
    expect(t?.fill.spreadCost).toBeCloseTo(94.95 * HALF_SPREAD, 10)
    expect(t?.fill.slippageCost).toBeCloseTo(94.95 * 2 * SLIPPAGE, 10)
    expect(t?.pnlGross).toBeCloseTo(exit - ENTRY, 10)
    expect(t?.realized).toBeCloseTo(exit - ENTRY - exit * TAKER, 10)
    expect(t?.position).toMatchObject({ side: 'long', qty: 1, markPrice: 94.9 })
    expect(t?.position.unrealized).toBeCloseTo(94.9 - ENTRY, 10)
    expect(await ex.getPositions()).toEqual([])
    expect(await ex.getOpenOrders(BTC)).toEqual([])
    expect((await ex.getBalance()).total).toBeCloseTo(1_000 - OPEN_FEE + (exit - ENTRY) - exit * TAKER, 10)
    // Ya cerrada, otro tick no hace nada.
    expect(ex.processTick(tick(90))).toEqual([])
  })

  it('el stop dispara justo en la marca igual al stop (como Binance)', async () => {
    const ex = makeExchange()
    await openLong(ex)
    await ex.placeStopMarket(stop(95))
    expect(ex.processTick(tick(95))).toHaveLength(1)
  })

  it('con nocional grande los dos slippages del stop crecen con el tamaño', async () => {
    const ex = makeExchange({ initialBalance: 10_000 })
    await openLong(ex, 300)
    await ex.placeStopMarket(stop(95))
    const [t] = ex.processTick(tick(94.9))
    // 300 × 94,9 = 28.470 de nocional ⇒ slippage 0,02% + 2 × 0,01% = 0,04%.
    const slippage = SLIPPAGE + 0.0002
    expect(t?.fill.price).toBeCloseTo(94.9 * (1 - (HALF_SPREAD + 2 * slippage)), 10)
    expect(t?.fill.slippageCost).toBeCloseTo(300 * 94.9 * 2 * slippage, 8)
  })

  it('TP y stop en la misma posición: dispara el primero que cruza y cancela el otro', async () => {
    const ex = makeExchange()
    await openLong(ex)
    const stopId = await ex.placeStopMarket(stop(95))
    const tpId = await ex.placeTakeProfitMarket(stop(105))
    expect(await ex.getOpenOrders(BTC)).toHaveLength(2)

    expect(ex.processTick(tick(104.9))).toEqual([])
    const triggered = ex.processTick(tick(105.2))
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ reason: 'take_profit', orderId: tpId, triggerPrice: 105 })
    expect(triggered[0]?.fill.price).toBeCloseTo(stopFill(105.2, -1), 10)
    expect(await ex.getOpenOrders(BTC)).toEqual([])
    await expect(ex.cancelOrder(BTC, stopId)).rejects.toThrow(/desconocida/)

    const ex2 = makeExchange()
    await openLong(ex2)
    const stop2 = await ex2.placeStopMarket(stop(95))
    await ex2.placeTakeProfitMarket(stop(105))
    expect(ex2.processTick(tick(94.9))[0]).toMatchObject({ reason: 'stop', orderId: stop2 })
    expect(await ex2.getOpenOrders()).toEqual([])
  })

  it('short: el stop dispara con marca ≥ stop y el TP con marca ≤ stop', async () => {
    const ex = makeExchange()
    await openShort(ex)
    await ex.placeStopMarket(stop(105, 'buy'))
    const tpId = await ex.placeTakeProfitMarket(stop(95, 'buy'))
    expect(ex.processTick(tick(104))).toEqual([])
    const [t] = ex.processTick(tick(94.5))
    expect(t).toMatchObject({ reason: 'take_profit', orderId: tpId })
    expect(t?.fill.side).toBe('buy')
    expect(t?.fill.price).toBeCloseTo(stopFill(94.5, 1), 10)
    expect(t?.pnlGross).toBeCloseTo(100 * (1 - HALF_SPREAD - SLIPPAGE) - stopFill(94.5, 1), 10)

    const ex2 = makeExchange()
    await openShort(ex2)
    const stopId = await ex2.placeStopMarket(stop(105, 'buy'))
    expect(ex2.processTick(tick(105.5))[0]).toMatchObject({ reason: 'stop', orderId: stopId })
  })

  it('getOpenOrders refleja cancelaciones; cancelar una orden desconocida lanza', async () => {
    const ex = makeExchange()
    await openLong(ex)
    const stopId = await ex.placeStopMarket(stop(95))
    const tpId = await ex.placeTakeProfitMarket(stop(105))
    expect(await ex.getOpenOrders(BTC)).toEqual([
      { id: stopId, symbol: BTC, type: 'STOP_MARKET', side: 'sell', stopPrice: 95 },
      { id: tpId, symbol: BTC, type: 'TAKE_PROFIT_MARKET', side: 'sell', stopPrice: 105 },
    ])
    await ex.cancelOrder(BTC, stopId)
    expect(await ex.getOpenOrders(BTC)).toEqual([{ id: tpId, symbol: BTC, type: 'TAKE_PROFIT_MARKET', side: 'sell', stopPrice: 105 }])
    expect(await ex.getOpenOrders()).toHaveLength(1)
    expect(await ex.getOpenOrders('ETHUSDT')).toEqual([])
    await expect(ex.cancelOrder(BTC, stopId)).rejects.toThrow(/desconocida/)
    await expect(ex.cancelOrder('ETHUSDT', tpId)).rejects.toThrow(/desconocida/)
    // Un stop cancelado ya no dispara.
    expect(ex.processTick(tick(94))).toEqual([])
    expect(await ex.getPositions()).toHaveLength(1)
  })

  it('getOpenOrders devuelve copias: mutarlas no toca el libro', async () => {
    const ex = makeExchange()
    await openLong(ex)
    await ex.placeStopMarket(stop(95))
    const [order] = await ex.getOpenOrders()
    if (order) order.stopPrice = 50
    expect((await ex.getOpenOrders())[0]?.stopPrice).toBe(95)
  })

  it('mover el stop (trailing) es cancelar y volver a colocar: el nuevo es el que dispara', async () => {
    const ex = makeExchange()
    await openLong(ex)
    const first = await ex.placeStopMarket(stop(95))
    ex.processTick(tick(103))
    await ex.cancelOrder(BTC, first)
    const moved = await ex.placeStopMarket(stop(102))
    expect(ex.processTick(tick(102.5))).toEqual([])
    expect(ex.processTick(tick(101.9))[0]).toMatchObject({ reason: 'stop', orderId: moved, triggerPrice: 102 })
  })

  it('rechaza órdenes condicionales inválidas', async () => {
    const ex = makeExchange()
    await expect(ex.placeStopMarket({ ...stop(95), symbol: 'NOPEUSDT' })).rejects.toThrow(/desconocido/)
    await expect(ex.placeStopMarket(stop(95))).rejects.toThrow(/sin posición/)
    await openLong(ex)
    await expect(ex.placeStopMarket(stop(0))).rejects.toThrow(/stopPrice/)
    await expect(ex.placeStopMarket(stop(100))).rejects.toThrow(/inmediato/)
    await expect(ex.placeTakeProfitMarket(stop(99))).rejects.toThrow(/inmediato/)
    await expect(ex.placeStopMarket(stop(95, 'buy'))).rejects.toThrow(/mismo lado/)
    await ex.placeStopMarket(stop(95))
    // Binance admite una sola orden closePosition por tipo y lado (error -4130).
    await expect(ex.placeStopMarket(stop(94))).rejects.toThrow(/ya hay una orden/)
    expect(await ex.getOpenOrders()).toHaveLength(1)
  })

  it('cerrar a mercado cancela las órdenes del símbolo', async () => {
    const ex = makeExchange()
    await openLong(ex)
    await ex.placeStopMarket(stop(95))
    await ex.closePosition(BTC, 'signal_flip')
    expect(await ex.getOpenOrders()).toEqual([])
    await expect(ex.closePosition(BTC, 'manual')).rejects.toThrow(/sin posición/)
  })
})

describe('PaperExchange — funding', () => {
  it('rate 0,0001, qty 2, mark 101 ⇒ el long paga 0,0202', async () => {
    const ex = makeExchange()
    await openLong(ex, 2)
    const applied = ex.applyFunding(funding(0.0001))
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ symbol: BTC, side: 'long', qty: 2, rate: 0.0001, markPrice: 101, at: 3_000 })
    expect(applied[0]?.amount).toBeCloseTo(-0.0202, 10)
    expect((await ex.getBalance()).total).toBeCloseTo(1_000 - 2 * OPEN_FEE - 0.0202, 10)
    expect((await ex.getPositions())[0]?.fundingPaid).toBeCloseTo(0.0202, 10)
  })

  it('el short cobra 0,0202; sin posición no pasa nada', async () => {
    const ex = makeExchange()
    await openShort(ex, 2)
    const before = (await ex.getBalance()).total
    const applied = ex.applyFunding(funding(0.0001))
    expect(applied[0]?.amount).toBeCloseTo(0.0202, 10)
    expect((await ex.getBalance()).total).toBeCloseTo(before + 0.0202, 10)
    expect((await ex.getPositions())[0]?.fundingPaid).toBeCloseTo(-0.0202, 10)
    expect(ex.applyFunding(funding(0.0001, 'ETHUSDT'))).toEqual([])
  })

  it('con tasa negativa el long cobra', async () => {
    const ex = makeExchange()
    await openLong(ex, 2)
    expect(ex.applyFunding(funding(-0.0001))[0]?.amount).toBeCloseTo(0.0202, 10)
  })

  it('rechaza un evento de funding no finito', async () => {
    const ex = makeExchange()
    await openLong(ex, 2)
    expect(() => ex.applyFunding(funding(Number.NaN))).toThrow(/funding/)
  })
})

describe('PaperExchange — margen aislado: la salida no pasa el precio de quiebra', () => {
  it('long 5x en 100, marca 99 dispara el stop y last tiene una mecha a 70 ⇒ sale en 80 y pierde el margen', async () => {
    const ex = frictionlessExchange()
    await openLong(ex)
    await ex.placeStopMarket(stop(99))
    // LP = 80,808…: la marca en 99 no liquida, pero el fill a last (70) pasaría la quiebra (80).
    const [t] = ex.processTick(tick(99, 70))
    expect(t).toMatchObject({ reason: 'stop', triggerPrice: 99, shortfall: 0 })
    expect(t?.fill).toMatchObject({ side: 'sell', qty: 1, cappedAtBankruptcy: true, spreadCost: 0, slippageCost: 0 })
    expect(t?.fill.price).toBeCloseTo(80, 10)
    expect(t?.fill.fee).toBeCloseTo(80 * TAKER, 10)
    expect(t?.pnlGross).toBeCloseTo(-20, 10)
    expect(t?.realized).toBeCloseTo(-(20 + 80 * TAKER), 10)
    expect((await ex.getBalance()).total).toBeCloseTo(1_000 - 100 * TAKER - 20 - 80 * TAKER, 10)
  })

  it('short con fill real: un TP que llena a last más allá de la quiebra pierde sólo el margen', async () => {
    const ex = makeExchange()
    const entry = await openShort(ex)
    const margin = entry.price / 5
    await ex.placeTakeProfitMarket(stop(95, 'buy'))
    // Marca en 94 (dispara el TP) y last disparado a 130: la quiebra es entrada × 1,2.
    const [t] = ex.processTick(tick(94, 130))
    expect(t).toMatchObject({ reason: 'take_profit' })
    expect(t?.fill.cappedAtBankruptcy).toBe(true)
    expect(t?.fill.price).toBeCloseTo(entry.price * 1.2, 10)
    expect(t?.pnlGross).toBeCloseTo(-margin, 10)
  })

  it('si el fill no llega a la quiebra no se toca', async () => {
    const ex = frictionlessExchange()
    await openLong(ex)
    await ex.placeStopMarket(stop(99))
    const [t] = ex.processTick(tick(99, 80.5))
    expect(t?.fill.price).toBeCloseTo(80.5, 10)
    expect(t?.fill.cappedAtBankruptcy).toBeUndefined()
  })

  it('un cierre a mercado con last más allá de la quiebra también se acota', async () => {
    const ex = frictionlessExchange()
    await openLong(ex)
    ex.setPrices(BTC, { mark: 99, last: 70 })
    const fill = await ex.closePosition(BTC, 'manual')
    expect(fill.cappedAtBankruptcy).toBe(true)
    expect(fill.price).toBeCloseTo(80, 10)
    expect((await ex.getBalance()).total).toBeCloseTo(1_000 - 100 * TAKER - 20 - 80 * TAKER, 10)
  })
})

describe('PaperExchange — liquidación', () => {
  it('long 5x entrada 100 mmr 1%: marca 80 ⇒ cierra con pérdida = margen completo + comisión', async () => {
    const ex = frictionlessExchange()
    const entry = await openLong(ex)
    expect(entry.price).toBe(100)
    const openFee = 100 * TAKER
    // LP = 100 × (1 − 1/5) / (1 − 0,01) = 80,808…
    expect(ex.processTick(tick(80.81))).toEqual([])
    await ex.placeTakeProfitMarket(stop(105))
    const [t] = ex.processTick(tick(80))
    expect(t).toMatchObject({ reason: 'liquidation', orderId: null, markPrice: 80, shortfall: 0, liquidationFeeRate: 0.0125 })
    expect(t?.triggerPrice).toBeCloseTo(80 / 0.99, 10)
    // Se cierra al precio de quiebra, entrada × (1 − 1/L) = 80: ahí el pnl es exactamente −margen.
    expect(t?.fill).toMatchObject({ side: 'sell', qty: 1, at: 2_000, spreadCost: 0, slippageCost: 0 })
    expect(t?.fill.price).toBeCloseTo(80, 10)
    expect(t?.pnlGross).toBeCloseTo(-20, 10)
    const closeFee = 80 * TAKER
    expect(t?.fill.fee).toBeCloseTo(closeFee, 10)
    expect(t?.realized).toBeCloseTo(-(20 + closeFee), 10)
    const balance = await ex.getBalance()
    expect(balance.total).toBeCloseTo(1_000 - openFee - 20 - closeFee, 10)
    expect(balance.marginInUse).toBe(0)
    expect(await ex.getPositions()).toEqual([])
    expect(await ex.getOpenOrders()).toEqual([]) // el TP queda cancelado
  })

  it('con fill de entrada real la pérdida sigue siendo el margen completo (el de la entrada 100,03)', async () => {
    const ex = makeExchange()
    await openLong(ex)
    const [t] = ex.processTick(tick(80, 80.5))
    expect(t?.triggerPrice).toBeCloseTo((ENTRY * 0.8) / 0.99, 10)
    expect(t?.fill.price).toBeCloseTo(ENTRY * 0.8, 10)
    expect(t?.pnlGross).toBeCloseTo(-MARGIN, 10)
    expect(t?.realized).toBeCloseTo(-(MARGIN + ENTRY * 0.8 * TAKER), 10)
  })

  it('la liquidación gana al stop cuando el mismo tick cruza los dos', async () => {
    const ex = makeExchange()
    await openLong(ex)
    await ex.placeStopMarket(stop(95))
    const triggered = ex.processTick(tick(70))
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ reason: 'liquidation', orderId: null })
    expect(triggered[0]?.pnlGross).toBeCloseTo(-MARGIN, 10)
  })

  it('el saldo nunca queda negativo: se recorta a 0 y se registra el faltante', async () => {
    // Saldo justo para abrir: margen 20 + comisión 0,05 = 20,05 ≤ 20,06.
    const ex = frictionlessExchange(20.06)
    await openLong(ex)
    const before = 20.06 - 100 * TAKER
    const owed = 20 + 80 * TAKER
    expect(owed).toBeGreaterThan(before)
    const [t] = ex.processTick(tick(80))
    expect(t?.pnlGross).toBeCloseTo(-20, 10)
    expect(t?.shortfall).toBeCloseTo(owed - before, 10)
    expect(t?.realized).toBeCloseTo(-before, 10)
    const balance = await ex.getBalance()
    expect(balance.total).toBe(0)
    expect(balance.available).toBe(0)
    expect(ex.totalShortfall()).toBeCloseTo(owed - before, 10)
  })

  it('short 5x: se liquida cuando la marca sube por encima de la liquidación', async () => {
    const ex = frictionlessExchange()
    await openShort(ex)
    const liq = 120 / 1.01
    expect(ex.processTick(tick(liq - 0.01))).toEqual([])
    const [t] = ex.processTick(tick(liq + 0.01))
    expect(t?.reason).toBe('liquidation')
    expect(t?.triggerPrice).toBeCloseTo(liq, 10)
    expect(t?.fill.price).toBeCloseTo(120, 10)
    expect(t?.fill.side).toBe('buy')
    expect(t?.pnlGross).toBeCloseTo(-20, 10)
  })
})

describe('PaperExchange — precios, posiciones, suscripciones y restauración', () => {
  it('getPositions valora con la marca vigente y processTick actualiza los precios', async () => {
    const ex = makeExchange()
    await openLong(ex)
    ex.processTick(tick(102, 101.9))
    const [pos] = await ex.getPositions()
    expect(pos?.markPrice).toBe(102)
    expect(pos?.unrealized).toBeCloseTo(102 - ENTRY, 10)
    expect((await ex.getBalance()).unrealized).toBeCloseTo(102 - ENTRY, 10)
    // El próximo fill usa el último precio del tick.
    const fill = await ex.closePosition(BTC, 'manual')
    expect(fill.price).toBeCloseTo(101.9 * (1 - HALF_SPREAD - SLIPPAGE), 10)
  })

  it('setPrices y processTick validan precios positivos y finitos', () => {
    const ex = makeExchange()
    expect(() => ex.setPrices(BTC, { mark: 0, last: 100 })).toThrow(/precio/)
    expect(() => ex.setPrices(BTC, { mark: 100, last: Number.NaN })).toThrow(/precio/)
    expect(() => ex.processTick(tick(-1))).toThrow(/precio/)
  })

  it('onMarkPrice y onFunding reciben lo que procesa el simulador hasta desuscribirse', () => {
    const ex = makeExchange()
    const ticks: number[] = []
    const rates: number[] = []
    const offTick = ex.onMarkPrice((t) => ticks.push(t.markPrice))
    const offFunding = ex.onFunding((ev) => rates.push(ev.rate))
    ex.processTick(tick(100))
    offTick()
    ex.processTick(tick(101))
    ex.applyFunding(funding(0.0001))
    offFunding()
    ex.applyFunding(funding(0.0002))
    expect(ticks).toEqual([100])
    expect(rates).toEqual([0.0001])
  })

  it('el constructor rechaza un saldo inicial inválido', () => {
    expect(() => makeExchange({ initialBalance: -1 })).toThrow(/saldo/)
    expect(() => makeExchange({ initialBalance: Number.NaN })).toThrow(/saldo/)
  })

  it('restorePosition reconstruye una posición persistida sin cobrar comisión', async () => {
    const ex = makeExchange({ initialBalance: 979.95 })
    ex.restorePosition({
      symbol: BTC,
      side: 'long',
      leverage: 5,
      margin: MARGIN,
      notional: ENTRY,
      qty: 1,
      entryPrice: ENTRY,
      openedAt: 500,
      liquidationPrice: (ENTRY * 0.8) / 0.99,
      feesPaid: OPEN_FEE,
      fundingPaid: 0,
    })
    const balance = await ex.getBalance()
    expect(balance.total).toBe(979.95)
    expect(balance.marginInUse).toBeCloseTo(MARGIN, 10)
    // Sin precio todavía, la posición se valora a la entrada.
    expect((await ex.getPositions())[0]).toMatchObject({ openedAt: 500, markPrice: ENTRY, unrealized: 0 })
    expect(() => ex.restorePosition({ symbol: BTC, side: 'short', leverage: 5, margin: 1, notional: 5, qty: 0.05, entryPrice: 100, openedAt: 0, liquidationPrice: 120, feesPaid: 0, fundingPaid: 0 })).toThrow(/ya hay/)
    expect(() => ex.restorePosition({ symbol: 'NOPEUSDT', side: 'short', leverage: 5, margin: 1, notional: 5, qty: 0.05, entryPrice: 100, openedAt: 0, liquidationPrice: 120, feesPaid: 0, fundingPaid: 0 })).toThrow(/desconocido/)
    ex.setPrices(BTC, { mark: 100, last: 100 })
    await ex.placeStopMarket(stop(95))
    expect(ex.processTick(tick(94))[0]?.reason).toBe('stop')
  })
})

describe('PaperExchange — restorePosition valida lo restaurado', () => {
  // Lo que dejó persistido la apertura de 1 BTC a 100,03 con 5x.
  function persisted(overrides: Partial<PositionState> = {}): PositionState {
    return {
      symbol: BTC,
      side: 'long',
      leverage: 5,
      margin: MARGIN,
      notional: ENTRY,
      qty: 1,
      entryPrice: ENTRY,
      openedAt: 500,
      liquidationPrice: (ENTRY * 0.8) / 0.99,
      feesPaid: OPEN_FEE,
      fundingPaid: 0,
      ...overrides,
    }
  }

  it('conserva una liquidación que difiere de la fórmula en menos que la tolerancia común', async () => {
    const ex = makeExchange()
    const stored = (ENTRY * 0.8) / 0.99 + 1e-10
    expect(ex.restorePosition(persisted({ liquidationPrice: stored }))).toEqual({ liquidationRecalculated: null })
    expect((await ex.getPositions())[0]?.liquidationPrice).toBe(stored)
  })

  it('con el mmr del contrato cambiado entre reinicios, restaura con la liquidación recalculada y lo informa', async () => {
    // Abierta con mmr 0,5%; hoy el contrato tiene 1%: como en Binance, vale la del mmr vigente.
    const stored = (ENTRY * 0.8) / 0.995
    const recalculated = (ENTRY * 0.8) / 0.99
    const ex = makeExchange()
    expect(ex.restorePosition(persisted({ liquidationPrice: stored }))).toEqual({ liquidationRecalculated: { from: stored, to: recalculated } })
    expect((await ex.getPositions())[0]?.liquidationPrice).toBe(recalculated)
    // 80,6 está por debajo de la liquidación nueva (≈ 80,83) y por encima de la vieja (≈ 80,43).
    const [liquidated] = ex.processTick(tick(80.6))
    expect(liquidated).toMatchObject({ reason: 'liquidation', triggerPrice: recalculated })
  })

  it('recalcula también una liquidación que no corresponde al lado o al apalancamiento guardados', async () => {
    const ex = makeExchange()
    const short = (ENTRY * 1.2) / 1.01
    expect(ex.restorePosition(persisted({ side: 'short', liquidationPrice: (ENTRY * 0.8) / 0.99 }))).toEqual({
      liquidationRecalculated: { from: (ENTRY * 0.8) / 0.99, to: short },
    })
    expect((await ex.getPositions())[0]?.liquidationPrice).toBe(short)
  })

  it('rechaza una cantidad no finita, fuera del stepSize o por debajo del minQty', () => {
    expect(() => makeExchange().restorePosition(persisted({ qty: Number.NaN }))).toThrow(/cantidad/)
    expect(() => makeExchange().restorePosition(persisted({ qty: 1.0005 }))).toThrow(/stepSize/)
    const ex = makeExchange({ infos: { [BTC]: btcLikeInfo({ minQty: 0.01 }) } })
    expect(() => ex.restorePosition(persisted({ qty: 0.005 }))).toThrow(/minQty/)
  })

  it('rechaza un margen que no entra en el saldo, contando las otras restauradas', async () => {
    expect(() => makeExchange({ initialBalance: 15 }).restorePosition(persisted())).toThrow(/margen/)
    const eth = 'ETHUSDT'
    const ex = makeExchange({ initialBalance: 30, infos: { [BTC]: btcLikeInfo(), [eth]: btcLikeInfo({ symbol: eth }) } })
    ex.restorePosition(persisted())
    expect(() => ex.restorePosition(persisted({ symbol: eth }))).toThrow(/margen/)
    expect((await ex.getPositions()).map((p) => p.symbol)).toEqual([BTC])
  })

  it('tolera un saldo debajo de los márgenes por el funding que pagaron las abiertas (el reinicio no se traba)', async () => {
    // En vivo el funding sale de la billetera, no del margen aislado: con margen cerca del
    // 100 % y días de funding pagado, el saldo queda debajo del margen en uso.
    const ex = makeExchange({ initialBalance: MARGIN - 3 })
    expect(() => ex.restorePosition(persisted({ fundingPaid: 3 }))).not.toThrow()
    expect((await ex.getPositions()).map((p) => p.symbol)).toEqual([BTC])
    // Más allá de lo pagado de funding sigue siendo una fila que no cierra.
    expect(() => makeExchange({ initialBalance: MARGIN - 3 }).restorePosition(persisted({ fundingPaid: 2 }))).toThrow(/margen/)
    // El funding cobrado no agranda la tolerancia.
    expect(() => makeExchange({ initialBalance: MARGIN - 3 }).restorePosition(persisted({ fundingPaid: -3 }))).toThrow(/margen/)
  })

  it('la tolerancia por funding suma lo pagado por todas las abiertas restauradas', async () => {
    const eth = 'ETHUSDT'
    const ex = makeExchange({ initialBalance: 2 * MARGIN - 4, infos: { [BTC]: btcLikeInfo(), [eth]: btcLikeInfo({ symbol: eth }) } })
    ex.restorePosition(persisted({ fundingPaid: 2 }))
    expect(() => ex.restorePosition(persisted({ symbol: eth, fundingPaid: 2 }))).not.toThrow()
    expect((await ex.getPositions()).map((p) => p.symbol).sort()).toEqual([BTC, eth].sort())
  })

  it('rechaza un precio de entrada que no es positivo o no es finito', () => {
    for (const entryPrice of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeExchange().restorePosition(persisted({ entryPrice }))).toThrow(/precio de entrada inválido/)
    }
  })

  it('rechaza un apalancamiento que no es entero o es menor que 1', () => {
    for (const leverage of [2.5, 0, -5, Number.NaN]) {
      expect(() => makeExchange().restorePosition(persisted({ leverage }))).toThrow(/apalancamiento inválido/)
    }
  })

  it('rechaza un margen que no es positivo o no es finito', () => {
    for (const margin of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeExchange().restorePosition(persisted({ margin }))).toThrow(/margen inválido/)
    }
  })

  it('rechaza una liquidación guardada que no es un precio (ningún mmr la explica)', () => {
    for (const liquidationPrice of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => makeExchange().restorePosition(persisted({ liquidationPrice }))).toThrow(/liquidación inválida/)
    }
  })

  it('una restauración rechazada no deja nada a medias', async () => {
    const ex = makeExchange()
    expect(() => ex.restorePosition(persisted({ entryPrice: 0 }))).toThrow()
    expect(await ex.getPositions()).toEqual([])
    await expect(ex.setLeverage(BTC, 3)).resolves.toBeUndefined()
  })
})
