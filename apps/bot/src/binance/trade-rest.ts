// Cliente de órdenes de Binance USDT-M para la sesión real: órdenes de mercado, stops y
// take profits por la API algorítmica, la cuenta y el listenKey. Va todo con prioridad alta
// en el limitador (pasa delante de la recolección de datos de mercado) y firmado, salvo la
// hora y el listenKey (USER_STREAM: sólo la clave). Endpoints, campos y pesos: cabecera de
// `trade-types.ts`.
//
// Crear una orden nunca se reintenta a ciegas: si Binance no contestó o contestó algo que
// deja la ejecución en duda, se consulta por el id de cliente y, si la orden entró, se
// devuelve esa. Si no aparece:
// - una de mercado no se vuelve a mandar: Binance puede ejecutarla después de contestar que
//   no existe (−1006/−1007, "execution status unknown") y, ya llena, deja de ser una orden
//   abierta, así que otra con el mismo id no se rechaza como duplicada y la cantidad se
//   duplica. El error vuelve a quien la pidió, que la trata como una orden en duda.
// - una algorítmica se manda una sola vez más con el mismo id: mientras está puesta es una
//   orden abierta y Binance rechaza el id repetido (−4116).
// Un id que terminó en duda se recuerda: si quien decide vuelve a pedirlo, primero se consulta.

import type { Logger } from 'pino'
import { silentLogger } from '../logger'
import { BinanceHttpError } from './errors'
import type { BinanceHttp, Cost, HttpMethod, Params } from './http'
import { num } from './numbers'
import { classifyBinanceError, isUnknownOutcome } from './trade-errors'
import { toAlgoOrder, toApiRestrictions, toIncomeRow, toOrderAck, toPosition, toUserTrade } from './trade-normalize'
import type {
  AlgoAck,
  AlgoKind,
  AlgoOrder,
  ApiRestrictions,
  BinancePosition,
  IncomeRow,
  OrderAck,
  OrderSide,
  RawAlgoOrder,
  RawApiRestrictions,
  RawBalance,
  RawFeeBurn,
  RawIncome,
  RawListenKey,
  RawMultiAssetsMode,
  RawOrder,
  RawPositionMode,
  RawPositionRisk,
  RawUserTrade,
  UserTrade,
} from './trade-types'
import type { RawServerTime } from './types'

export interface MarketOrderRequest {
  symbol: string
  side: OrderSide
  // Ya en la grilla del contrato (`formatQty`).
  quantity: string
  reduceOnly: boolean
  clientOrderId: string
}

export interface AlgoOrderRequest {
  symbol: string
  side: OrderSide
  type: AlgoKind
  // Ya en la grilla del contrato (`formatPrice`/`formatQty`).
  triggerPrice: string
  quantity: string
  clientAlgoId: string
}

// Con `startTime` y `endTime`, Binance acepta ventanas de hasta 7 días.
export interface UserTradesQuery {
  startTime?: number
  endTime?: number
  orderId?: number
}

export interface BinanceTradeRestOptions {
  http: BinanceHttp
  // `/sapi` (otro host, otro límite de peso); null en testnet, donde no existe.
  sapi: BinanceHttp | null
  logger?: Logger
  sleep?: (ms: number) => Promise<void>
  // Espera antes de consultar una orden en duda: Binance puede tardar en registrarla.
  unknownOutcomeDelayMs?: number
}

const ORDER = '/fapi/v1/order'
const ALGO = '/fapi/v1/algoOrder'
const LISTEN_KEY = '/fapi/v1/listenKey'
// Crear órdenes pesa 0 en el límite de la IP (cuenta en el de órdenes de la cuenta), pero el
// limitador cuenta al menos 1 por pedido.
const CREATE_WEIGHT = 1
// Orden inexistente: −2013 (consulta) o −2011 "Unknown order sent." (cancelación).
const NOT_FOUND_CODES: ReadonlySet<number> = new Set([-2013, -2011])
const DUPLICATE_CLIENT_ID = -4116
// Cuántas veces sale una orden con el mismo id si queda en duda (cabecera).
const MARKET_SENDS = 1
const ALGO_SENDS = 2
const ALREADY_ISOLATED = -4046
const MAX_ROWS = 1_000
// `userTrades` con `startTime` y `endTime` acepta ventanas de hasta 7 días.
const TRADES_WINDOW_MS = 7 * 24 * 3_600_000

const weight = (w: number): Cost => ({ kind: 'weight', weight: w })

export class BinanceTradeRest {
  private readonly http: BinanceHttp
  private readonly sapi: BinanceHttp | null
  private readonly logger: Logger
  private readonly sleep: (ms: number) => Promise<void>
  private readonly unknownOutcomeDelayMs: number
  // Ids de cliente cuya última creación quedó en duda (no se sabe si entraron).
  private readonly unresolved = new Set<string>()

  constructor(opts: BinanceTradeRestOptions) {
    if (!opts.http.hasKey()) throw new Error('Binance: el cliente de órdenes necesita la clave y el secret de operación')
    this.http = opts.http
    this.sapi = opts.sapi
    this.logger = opts.logger ?? silentLogger
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.unknownOutcomeDelayMs = opts.unknownOutcomeDelayMs ?? 1_000
  }

  // ---------- Órdenes ----------

  marketOrder(req: MarketOrderRequest): Promise<OrderAck> {
    const params: Params = {
      symbol: req.symbol,
      side: req.side,
      type: 'MARKET',
      quantity: req.quantity,
      reduceOnly: req.reduceOnly ? 'true' : undefined,
      newClientOrderId: req.clientOrderId,
      newOrderRespType: 'RESULT',
    }
    return this.createOnce(
      ORDER,
      req.clientOrderId,
      async () => toOrderAck(await this.signed<RawOrder>(ORDER, params, weight(CREATE_WEIGHT), 'POST', 'never')),
      () => this.queryOrder(req.symbol, req.clientOrderId),
      MARKET_SENDS,
    )
  }

  // Siempre `reduceOnly` por la cantidad del bot y disparado por la marca; nunca
  // `closePosition` (cerraría también lo que Toti sume a mano) ni `priceProtect` (podría
  // dejar sin disparar un stop justo cuando la marca y el último precio se separan).
  algoOrder(req: AlgoOrderRequest): Promise<AlgoAck> {
    const params: Params = {
      algoType: 'CONDITIONAL',
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      triggerPrice: req.triggerPrice,
      quantity: req.quantity,
      reduceOnly: 'true',
      workingType: 'MARK_PRICE',
      clientAlgoId: req.clientAlgoId,
    }
    return this.createOnce(
      ALGO,
      req.clientAlgoId,
      async () => toAlgoOrder(await this.signed<RawAlgoOrder>(ALGO, params, weight(CREATE_WEIGHT), 'POST', 'never')),
      () => this.queryAlgo(req.clientAlgoId),
      ALGO_SENDS,
    )
  }

  // Cancelar no lleva `symbol`: Binance sólo acepta `algoId` o `clientAlgoId`. Una orden que
  // ya no existe (disparó, se canceló antes o nunca entró) cuenta como cancelada.
  async cancelAlgo(clientAlgoId: string): Promise<void> {
    try {
      await this.signed(ALGO, { clientAlgoId }, weight(1), 'DELETE')
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  async openAlgoOrders(symbol?: string): Promise<AlgoOrder[]> {
    const raw = await this.signed<RawAlgoOrder[]>('/fapi/v1/openAlgoOrders', { symbol }, weight(symbol === undefined ? 40 : 1))
    return raw.map(toAlgoOrder)
  }

  queryOrder(symbol: string, clientOrderId: string): Promise<OrderAck | null> {
    return this.orNull(async () => toOrderAck(await this.signed<RawOrder>(ORDER, { symbol, origClientOrderId: clientOrderId }, weight(1))))
  }

  // Por el id de Binance: los trades no traen el id de cliente de su orden.
  queryOrderById(symbol: string, orderId: number): Promise<OrderAck | null> {
    return this.orNull(async () => toOrderAck(await this.signed<RawOrder>(ORDER, { symbol, orderId }, weight(1))))
  }

  queryAlgo(clientAlgoId: string): Promise<AlgoOrder | null> {
    return this.orNull(async () => toAlgoOrder(await this.signed<RawAlgoOrder>(ALGO, { clientAlgoId }, weight(1))))
  }

  // ---------- Cuenta ----------

  // Sólo las posiciones abiertas: la V2 trae una fila por contrato, casi todas en cero.
  async positionRisk(): Promise<BinancePosition[]> {
    const raw = await this.signed<RawPositionRisk[]>('/fapi/v2/positionRisk', {}, weight(5))
    return raw.map(toPosition).filter((p) => p.amount !== 0)
  }

  async userTrades(symbol: string, query: UserTradesQuery): Promise<UserTrade[]> {
    const raw = await this.signed<RawUserTrade[]>('/fapi/v1/userTrades', { symbol, ...query, limit: MAX_ROWS }, weight(5))
    return raw.map(toUserTrade)
  }

  // Todos los trades de la moneda entre `startTime` y `endTime` (incluidos), del más viejo al
  // más nuevo. Va en ventanas de 7 días y parte en dos la que vuelve llena: así no depende de
  // qué página elige Binance cuando hay más de 1000 filas.
  async userTradesBetween(symbol: string, startTime: number, endTime: number): Promise<UserTrade[]> {
    const found = new Map<number, UserTrade>()
    for (let from = startTime; from <= endTime; from += TRADES_WINDOW_MS) {
      await this.collectTrades(symbol, from, Math.min(endTime, from + TRADES_WINDOW_MS - 1), found)
    }
    return [...found.values()].sort((a, b) => a.time - b.time || a.id - b.id)
  }

  async fundingIncome(startTime: number): Promise<IncomeRow[]> {
    const raw = await this.signed<RawIncome[]>('/fapi/v1/income', { incomeType: 'FUNDING_FEE', startTime, limit: MAX_ROWS }, weight(30))
    return raw.map(toIncomeRow)
  }

  async setIsolated(symbol: string): Promise<void> {
    try {
      await this.signed('/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }, weight(1), 'POST')
    } catch (err) {
      if (!(err instanceof BinanceHttpError && err.code === ALREADY_ISOLATED)) throw err
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!Number.isInteger(leverage) || leverage < 1) throw new RangeError(`Binance: apalancamiento inválido ${leverage}`)
    await this.signed('/fapi/v1/leverage', { symbol, leverage }, weight(1), 'POST')
  }

  async dualSide(): Promise<boolean> {
    return (await this.signed<RawPositionMode>('/fapi/v1/positionSide/dual', {}, weight(30))).dualSidePosition
  }

  async multiAssets(): Promise<boolean> {
    return (await this.signed<RawMultiAssetsMode>('/fapi/v1/multiAssetsMargin', {}, weight(30))).multiAssetsMargin
  }

  async feeBurn(): Promise<boolean> {
    return (await this.signed<RawFeeBurn>('/fapi/v1/feeBurn', {}, weight(30))).feeBurn
  }

  // null sin `/sapi` (testnet): ese chequeo se saltea y se dice.
  async apiRestrictions(): Promise<ApiRestrictions | null> {
    if (this.sapi === null) return null
    const raw = await this.sapi.request<RawApiRestrictions>('/sapi/v1/account/apiRestrictions', {}, weight(1), { signed: true, priority: 'high' })
    return toApiRestrictions(raw)
  }

  // La billetera USDT de futuros (sin no realizado) y lo disponible para margen nuevo.
  async usdtBalance(): Promise<{ wallet: number; available: number }> {
    const raw = await this.signed<RawBalance[]>('/fapi/v3/balance', {}, weight(5))
    const usdt = raw.find((b) => b.asset === 'USDT')
    if (!usdt) return { wallet: 0, available: 0 }
    return { wallet: num(usdt.balance), available: num(usdt.availableBalance) }
  }

  async serverTime(): Promise<number> {
    return (await this.http.request<RawServerTime>('/fapi/v1/time', {}, weight(1), { priority: 'high' })).serverTime
  }

  // ---------- listenKey (USER_STREAM: con la clave, sin firma) ----------

  async listenKeyCreate(): Promise<string> {
    return (await this.http.request<RawListenKey>(LISTEN_KEY, {}, weight(1), { method: 'POST', priority: 'high' })).listenKey
  }

  async listenKeyKeepAlive(): Promise<void> {
    await this.http.request(LISTEN_KEY, {}, weight(1), { method: 'PUT', priority: 'high' })
  }

  async listenKeyClose(): Promise<void> {
    await this.http.request(LISTEN_KEY, {}, weight(1), { method: 'DELETE', priority: 'high' })
  }

  // ---------- Internos ----------

  private signed<T>(path: string, params: Params, cost: Cost, method: HttpMethod = 'GET', retry: 'safe' | 'never' = 'safe'): Promise<T> {
    return this.http.request<T>(path, params, cost, { signed: true, method, retry, priority: 'high' })
  }

  private async collectTrades(symbol: string, from: number, to: number, into: Map<number, UserTrade>): Promise<void> {
    const page = await this.userTrades(symbol, { startTime: from, endTime: to })
    if (page.length >= MAX_ROWS && to > from) {
      const middle = Math.floor((from + to) / 2)
      await this.collectTrades(symbol, from, middle, into)
      await this.collectTrades(symbol, middle + 1, to, into)
      return
    }
    if (page.length >= MAX_ROWS) this.logger.warn({ symbol, at: from }, 'Binance: más de 1000 trades en el mismo milisegundo; se toma la primera página')
    for (const t of page) into.set(t.id, t)
  }

  private async orNull<T>(query: () => Promise<T>): Promise<T | null> {
    try {
      return await query()
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  // Manda la orden a lo sumo `sends` veces con el mismo id, consultando después de cada una
  // que queda en duda.
  private async createOnce<T>(path: string, clientId: string, send: () => Promise<T>, find: () => Promise<T | null>, sends: number): Promise<T> {
    if (this.unresolved.has(clientId)) {
      const found = await this.findAfterDoubt(path, clientId, find, null)
      if (found !== null) return found
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await send()
        this.unresolved.delete(clientId)
        return result
      } catch (err) {
        // El id ya está entre las abiertas: entró en una vuelta anterior.
        if (err instanceof BinanceHttpError && err.code === DUPLICATE_CLIENT_ID) {
          const found = await this.findAfterDoubt(path, clientId, find, err)
          if (found !== null) return found
          throw err
        }
        if (!isUnknownOutcome(err)) {
          this.unresolved.delete(clientId)
          throw err
        }
        this.unresolved.add(clientId)
        this.logger.warn({ path, clientId, reason: classifyBinanceError(err).message }, 'Binance: la orden quedó en duda; se consulta por id de cliente')
        const found = await this.findAfterDoubt(path, clientId, find, err)
        if (found !== null) return found
        if (attempt + 1 >= sends) throw err
      }
    }
  }

  // Si la consulta también falla, no se sabe si la orden entró: se devuelve el error original
  // (o el de la consulta) y el id queda en duda para la próxima vuelta.
  private async findAfterDoubt<T>(path: string, clientId: string, find: () => Promise<T | null>, original: unknown): Promise<T | null> {
    await this.sleep(this.unknownOutcomeDelayMs)
    let found: T | null
    try {
      found = await find()
    } catch (queryErr) {
      this.logger.warn({ path, clientId, reason: classifyBinanceError(queryErr).message }, 'Binance: no se pudo consultar la orden en duda; no se reintenta a ciegas')
      throw original ?? queryErr
    }
    if (found !== null) this.unresolved.delete(clientId)
    return found
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof BinanceHttpError && err.code !== null && NOT_FOUND_CODES.has(err.code)
}
