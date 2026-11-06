// Las rutas de operación del Binance falso: validan cada pedido como Binance (clave, firma,
// parámetros, grilla del contrato) y lo pasan a `FakeTrading`. Contestan con los nombres de
// campo de `trade-types.ts`. Más reglas de Sereno que Binance no impone pero el bot nunca
// debe romper: `closePosition=true` en una algorítmica se rechaza.

import { randomBytes } from 'node:crypto'
import type { OrderSide, RawApiRestrictions, RawBalance, RawPositionRisk } from '../trade-types'
import { verifyApiKey, verifySigned, type FakeAccount, type FakeAnswer, type FakeRejection } from './account'
import { PERPETUAL_SYMBOLS } from './fixtures'
import { contractRules, FakeBinanceReject, isConditionalType, onGrid, plain, type FakeTrading } from './trading'

export interface TradingRequest {
  method: string
  path: string
  query: Record<string, string>
  rawQuery: string
  apiKey: string | null
}

type Handler = (trading: FakeTrading, q: Record<string, string>) => unknown

interface Route {
  weight: number | ((q: Record<string, string>) => number)
  // USER_STREAM (listenKey): sólo la clave, sin firma.
  keyOnly?: boolean
  handler: Handler
}

const CLIENT_ID = /^[.A-Z:/a-z0-9_-]{1,36}$/

const ROUTES: Record<string, Route> = {
  'POST /fapi/v1/order': { weight: 0, handler: newOrder },
  'GET /fapi/v1/order': { weight: 1, handler: queryOrder },
  'POST /fapi/v1/algoOrder': { weight: 0, handler: newAlgo },
  'GET /fapi/v1/algoOrder': { weight: 1, handler: queryAlgo },
  'DELETE /fapi/v1/algoOrder': { weight: 1, handler: cancelAlgo },
  'GET /fapi/v1/openAlgoOrders': { weight: (q) => (q.symbol === undefined ? 40 : 1), handler: openAlgos },
  'GET /fapi/v2/positionRisk': { weight: 5, handler: positionRisk },
  'GET /fapi/v1/userTrades': { weight: 5, handler: userTrades },
  'GET /fapi/v1/income': { weight: 30, handler: income },
  'POST /fapi/v1/marginType': { weight: 1, handler: marginType },
  'POST /fapi/v1/leverage': { weight: 1, handler: leverage },
  'GET /fapi/v1/positionSide/dual': { weight: 30, handler: (t) => ({ dualSidePosition: t.options.dualSide }) },
  'GET /fapi/v1/multiAssetsMargin': { weight: 30, handler: (t) => ({ multiAssetsMargin: t.options.multiAssets }) },
  'GET /fapi/v1/feeBurn': { weight: 30, handler: (t) => ({ feeBurn: t.options.feeBurn }) },
  'GET /fapi/v3/balance': { weight: 5, handler: balance },
  'POST /fapi/v1/listenKey': { weight: 1, keyOnly: true, handler: (t) => ({ listenKey: (t.listenKey ??= randomKey()) }) },
  'PUT /fapi/v1/listenKey': { weight: 1, keyOnly: true, handler: keepAlive },
  'DELETE /fapi/v1/listenKey': { weight: 1, keyOnly: true, handler: closeListenKey },
  'GET /sapi/v1/account/apiRestrictions': { weight: 1, handler: apiRestrictions },
}

// La respuesta de una ruta de operación, o undefined si la ruta no es de operación.
export function answerTrading(trading: FakeTrading, account: FakeAccount, req: TradingRequest, { sapiEnabled }: { sapiEnabled: boolean }): FakeAnswer | undefined {
  if (!sapiEnabled && (req.path.startsWith('/sapi/') || req.path.startsWith('/api/'))) return undefined
  const route = ROUTES[`${req.method} ${req.path}`]
  if (!route) return undefined
  const weight = typeof route.weight === 'number' ? route.weight : route.weight(req.query)
  const rejection = route.keyOnly ? verifyApiKey(account, req.apiKey) : verifySigned(account, { rawQuery: req.rawQuery, apiKey: req.apiKey, now: trading.now() })
  if (rejection) return { ...rejection, weight }
  if (req.method !== 'GET') {
    const scripted = trading.takeReject(req.path)
    if (scripted) return { status: statusFor(scripted.code), body: scripted, weight }
  }
  try {
    return { status: 200, body: route.handler(trading, req.query), weight }
  } catch (err) {
    if (err instanceof FakeBinanceReject) return { ...rejectionOf(err), weight }
    throw err
  }
}

// El status HTTP con el que Binance acompaña cada código guionado.
function statusFor(code: number): number {
  if (code === -1001 || code === -1008) return 503
  if (code === -1006 || code === -1007) return 408
  if (code === -1003) return 429
  if (code === -2015 || code === -2014) return 401
  return 400
}

function rejectionOf(err: FakeBinanceReject): FakeRejection {
  return { status: err.status, body: { code: err.code, msg: err.message } }
}

// ---------- Órdenes ----------

function newOrder(t: FakeTrading, q: Record<string, string>): unknown {
  rejectHedge(t)
  const symbol = required(q, 'symbol')
  const side = sideOf(q)
  const type = required(q, 'type')
  if (isConditionalType(type)) throw new FakeBinanceReject(400, -4120, 'Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.')
  if (type !== 'MARKET') throw new FakeBinanceReject(400, -1116, 'Invalid orderType.')
  const qty = quantityOf(q, symbol)
  const clientOrderId = clientIdOf(q, 'newClientOrderId')
  const req = { symbol, side, qty, reduceOnly: q.reduceOnly === 'true', clientOrderId }
  t.holdIfLate(req)
  const order = t.placeMarket(req)
  if (q.newOrderRespType === 'RESULT') return order
  // ACK: lo que Binance sabe al aceptarla, antes de ejecutar.
  return { ...order, status: 'NEW', executedQty: '0', cumQty: '0', cumQuote: '0', avgPrice: '0.00' }
}

function queryOrder(t: FakeTrading, q: Record<string, string>): unknown {
  const symbol = required(q, 'symbol')
  if (q.orderId === undefined && q.origClientOrderId === undefined) throw new FakeBinanceReject(400, -1102, "Param 'origClientOrderId' or 'orderId' must be sent, but both were empty/null!")
  const order = t.findOrder(symbol, q.orderId !== undefined ? { orderId: Number(q.orderId) } : { clientOrderId: q.origClientOrderId! })
  if (!order) throw new FakeBinanceReject(400, -2013, 'Order does not exist.')
  return order
}

function newAlgo(t: FakeTrading, q: Record<string, string>): unknown {
  rejectHedge(t)
  if (required(q, 'algoType') !== 'CONDITIONAL') throw new FakeBinanceReject(400, -1116, 'Invalid algoType.')
  const symbol = required(q, 'symbol')
  const side = sideOf(q)
  const type = required(q, 'type')
  if (type !== 'STOP_MARKET' && type !== 'TAKE_PROFIT_MARKET') throw new FakeBinanceReject(400, -1116, `FakeBinance: tipo ${type} no soportado`)
  if (q.closePosition === 'true') throw new FakeBinanceReject(400, -1106, "Parameter 'closePosition' sent when not required. (Sereno nunca usa closePosition)")
  const triggerPrice = required(q, 'triggerPrice')
  const trigger = Number(triggerPrice)
  const { tickSize } = contractRules(symbol)
  if (!(trigger > 0)) throw new FakeBinanceReject(400, -1102, "Mandatory parameter 'triggerPrice' was not sent, was empty/null, or malformed.")
  if (!onGrid(trigger, tickSize)) throw new FakeBinanceReject(400, -1111, 'Precision is over the maximum defined for this asset.')
  quantityOf(q, symbol)
  const workingType = q.workingType ?? 'CONTRACT_PRICE'
  if (workingType !== 'MARK_PRICE' && workingType !== 'CONTRACT_PRICE') throw new FakeBinanceReject(400, -1116, 'Invalid workingType.')
  return t.placeAlgo({
    symbol,
    side,
    type,
    triggerPrice,
    quantity: required(q, 'quantity'),
    reduceOnly: q.reduceOnly === 'true',
    workingType,
    priceProtect: q.priceProtect === 'true',
    clientAlgoId: clientIdOf(q, 'clientAlgoId'),
  })
}

function queryAlgo(t: FakeTrading, q: Record<string, string>): unknown {
  const algo = t.findAlgo(algoRef(q))
  if (!algo) throw new FakeBinanceReject(400, -2013, 'Order does not exist.')
  return algo
}

function cancelAlgo(t: FakeTrading, q: Record<string, string>): unknown {
  const algo = t.cancelAlgo(algoRef(q))
  return { algoId: algo.algoId, clientAlgoId: algo.clientAlgoId, code: '200', msg: 'success' }
}

function openAlgos(t: FakeTrading, q: Record<string, string>): unknown {
  return t.algos.filter((a) => a.algoStatus === 'NEW' && (q.symbol === undefined || a.symbol === q.symbol))
}

// ---------- Cuenta ----------

// Una fila por contrato, como la V2: con cantidad 0 donde no hay posición.
function positionRisk(t: FakeTrading): RawPositionRisk[] {
  const symbols = [...new Set([...PERPETUAL_SYMBOLS, ...t.symbolsWithPosition()])]
  return symbols.map((symbol) => {
    const p = t.position(symbol)
    const mark = p ? t.mark(symbol) : 0
    const isolated = t.marginType(symbol) === 'isolated'
    const unrealized = p ? p.amount * (mark - p.entryPrice) : 0
    const lev = t.leverage(symbol)
    return {
      symbol,
      positionAmt: plain(p?.amount ?? 0),
      entryPrice: plain(p?.entryPrice ?? 0),
      breakEvenPrice: plain(p?.entryPrice ?? 0),
      markPrice: plain(mark),
      unRealizedProfit: plain(unrealized),
      liquidationPrice: plain(t.liquidationPrice(symbol) ?? 0),
      leverage: String(lev),
      maxNotionalValue: '1000000',
      marginType: isolated ? 'isolated' : 'cross',
      isolatedMargin: isolated && p ? plain(p.margin + unrealized) : '0',
      isAutoAddMargin: 'false',
      positionSide: 'BOTH',
      notional: plain(p ? p.amount * mark : 0),
      isolatedWallet: isolated && p ? plain(p.margin) : '0',
      updateTime: t.now(),
    }
  })
}

function userTrades(t: FakeTrading, q: Record<string, string>): unknown {
  const symbol = required(q, 'symbol')
  const limit = q.limit !== undefined ? Number(q.limit) : 500
  return t.trades
    .filter(
      (r) =>
        r.symbol === symbol &&
        (q.orderId === undefined || r.orderId === Number(q.orderId)) &&
        (q.startTime === undefined || r.time >= Number(q.startTime)) &&
        (q.endTime === undefined || r.time <= Number(q.endTime)) &&
        (q.fromId === undefined || r.id >= Number(q.fromId)),
    )
    .slice(0, limit)
}

function income(t: FakeTrading, q: Record<string, string>): unknown {
  const limit = q.limit !== undefined ? Number(q.limit) : 100
  return t.income
    .filter(
      (r) =>
        (q.incomeType === undefined || r.incomeType === q.incomeType) &&
        (q.symbol === undefined || r.symbol === q.symbol) &&
        (q.startTime === undefined || r.time >= Number(q.startTime)) &&
        (q.endTime === undefined || r.time <= Number(q.endTime)),
    )
    .slice(0, limit)
}

function marginType(t: FakeTrading, q: Record<string, string>): unknown {
  const symbol = required(q, 'symbol')
  const type = required(q, 'marginType')
  if (type !== 'ISOLATED' && type !== 'CROSSED') throw new FakeBinanceReject(400, -1116, 'Invalid marginType.')
  t.setMarginType(symbol, type === 'ISOLATED' ? 'isolated' : 'cross')
  return { code: 200, msg: 'success' }
}

function leverage(t: FakeTrading, q: Record<string, string>): unknown {
  const symbol = required(q, 'symbol')
  const value = Number(required(q, 'leverage'))
  t.setLeverage(symbol, value)
  return { leverage: value, maxNotionalValue: '1000000', symbol }
}

function balance(t: FakeTrading): RawBalance[] {
  const wallet = t.walletBalance()
  return [
    {
      accountAlias: 'SgsR',
      asset: 'USDT',
      balance: plain(wallet),
      crossWalletBalance: plain(t.available()),
      crossUnPnl: '0',
      availableBalance: plain(t.available()),
      maxWithdrawAmount: plain(t.available()),
      marginAvailable: true,
      updateTime: t.now(),
    },
  ]
}

function keepAlive(t: FakeTrading): unknown {
  if (t.listenKey === null) throw new FakeBinanceReject(400, -1125, 'This listenKey does not exist.')
  return { listenKey: t.listenKey }
}

function closeListenKey(t: FakeTrading): unknown {
  t.listenKey = null
  return {}
}

function apiRestrictions(t: FakeTrading): RawApiRestrictions {
  const { enableFutures, enableWithdrawals, ipRestrict } = t.options.restrictions
  return {
    ipRestrict,
    createTime: 1_623_840_271_000,
    enableReading: true,
    enableWithdrawals,
    enableInternalTransfer: false,
    enableMargin: false,
    enableFutures,
    permitsUniversalTransfer: false,
    enableVanillaOptions: false,
    enableFixApiTrade: false,
    enableFixReadOnly: false,
    enableSpotAndMarginTrading: false,
    enablePortfolioMarginTrading: false,
  }
}

// ---------- Parámetros ----------

function rejectHedge(t: FakeTrading): void {
  // En modo cobertura toda orden necesita `positionSide`; Sereno nunca lo manda.
  if (t.options.dualSide) throw new FakeBinanceReject(400, -4061, "Order's position side does not match user's setting.")
}

function required(q: Record<string, string>, key: string): string {
  const value = q[key]
  if (!value) throw new FakeBinanceReject(400, -1102, `Mandatory parameter '${key}' was not sent, was empty/null, or malformed.`)
  return value
}

function sideOf(q: Record<string, string>): OrderSide {
  const side = required(q, 'side')
  if (side !== 'BUY' && side !== 'SELL') throw new FakeBinanceReject(400, -1117, 'Invalid side.')
  return side
}

function quantityOf(q: Record<string, string>, symbol: string): number {
  const qty = Number(required(q, 'quantity'))
  const { stepSize, maxQty } = contractRules(symbol)
  if (!Number.isFinite(qty) || qty <= 0) throw new FakeBinanceReject(400, -4003, 'Quantity less than or equal to zero.')
  if (!onGrid(qty, stepSize)) throw new FakeBinanceReject(400, -1111, 'Precision is over the maximum defined for this asset.')
  if (qty > maxQty) throw new FakeBinanceReject(400, -4005, 'Quantity greater than max quantity.')
  return qty
}

function clientIdOf(q: Record<string, string>, key: string): string {
  const id = q[key] ?? `x-${randomKey().slice(0, 20)}`
  if (id.length > 36) throw new FakeBinanceReject(400, -4015, 'Client order id length should not be more than 36 chars')
  if (!CLIENT_ID.test(id)) throw new FakeBinanceReject(400, -1100, `Illegal characters found in parameter '${key}'; legal range is '^[\\.A-Z\\:/a-z0-9_-]{1,36}$'.`)
  return id
}

function algoRef(q: Record<string, string>): { algoId: number } | { clientAlgoId: string } {
  if (q.algoId !== undefined) return { algoId: Number(q.algoId) }
  if (q.clientAlgoId !== undefined) return { clientAlgoId: q.clientAlgoId }
  throw new FakeBinanceReject(400, -1102, "Param 'clientAlgoId' or 'algoId' must be sent, but both were empty/null!")
}

function randomKey(): string {
  return randomBytes(32).toString('hex')
}
