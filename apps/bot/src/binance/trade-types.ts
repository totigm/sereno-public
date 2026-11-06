// Tipos del cable de Binance USDT-M para operar (órdenes, algorítmicas, cuenta, user data
// stream) y las formas normalizadas que expone `BinanceTradeRest`. El Binance falso
// (`fake/trading.ts`) contesta con exactamente estos nombres de campo.
//
// Verificado en la documentación oficial el 2026-11-01 (sólo lectura de la documentación;
// nunca se llamó a Binance):
// - Órdenes algorítmicas (desde 2025-12-09 `STOP_MARKET`/`TAKE_PROFIT_MARKET` van sólo por
//   acá; en `POST /fapi/v1/order` y `/batchOrders` son −4120 STOP_ORDER_SWITCH_ALGO):
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order
//   `POST /fapi/v1/algoOrder` (TRADE, peso IP 0; 1 en los límites de órdenes de 10 s y 1 min):
//   `algoType=CONDITIONAL`, `symbol`, `side`, `type`, `quantity`, `triggerPrice`,
//   `workingType` (MARK_PRICE | CONTRACT_PRICE, default CONTRACT_PRICE), `priceProtect`,
//   `reduceOnly` ("true"/"false"; no con `closePosition` ni en modo cobertura),
//   `closePosition`, `clientAlgoId` (1 a 36 caracteres: letras, dígitos y `. : / _ -`).
//   La respuesta trae `algoId`, `clientAlgoId`, `algoType`, `orderType`, `algoStatus`,
//   `triggerPrice`, `quantity`, `workingType`, `reduceOnly`, `closePosition`, `createTime`…
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Cancel-Algo-Order
//   `DELETE /fapi/v1/algoOrder` (peso 1): sólo `algoId` o `clientAlgoId` (no lleva `symbol`);
//   responde `{ algoId, clientAlgoId, code: "200", msg: "success" }`.
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Query-Algo-Order
//   `GET /fapi/v1/algoOrder` (peso 1): `algoId` o `clientAlgoId`; suma `actualOrderId`
//   ("" si no disparó), `actualPrice`, `actualType`, `actualQty`.
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Current-All-Algo-Open-Orders
//   `GET /fapi/v1/openAlgoOrders` (peso 1 con `symbol`, 40 sin él).
// - Orden de mercado: `POST /fapi/v1/order` (peso IP 0), `newClientOrderId` con
//   `^[\.A-Z\:/a-z0-9_-]{1,36}$`, `newOrderRespType` ACK (default) | RESULT (una MARKET
//   vuelve con su estado final). `GET /fapi/v1/order` (peso 1) con `origClientOrderId`.
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Query-Order
// - Posiciones: `GET /fapi/v2/positionRisk` (peso 5). La V3 (`/fapi/v3/positionRisk`, peso 5)
//   ya no trae `leverage` ni `marginType`, que el bot necesita: se usa la V2, vigente.
// - `GET /fapi/v1/userTrades` (peso 5; `orderId` exige `symbol`; ventana máxima de 7 días),
//   `GET /fapi/v1/income` (peso 30; `incomeType=FUNDING_FEE`; `limit` hasta 1000),
//   `POST /fapi/v1/marginType` (peso 1; −4046 "No need to change margin type."),
//   `POST /fapi/v1/leverage` (peso 1), `GET /fapi/v1/positionSide/dual` (peso 30,
//   `dualSidePosition`), `GET /fapi/v1/multiAssetsMargin` (peso 30), `GET /fapi/v1/feeBurn`
//   (peso 30), `GET /fapi/v3/balance` (peso 5), `POST|PUT|DELETE /fapi/v1/listenKey` (peso 1,
//   USER_STREAM: va la clave, sin firma; −1125 si el listenKey no existe).
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Account-Trade-List
//   https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Current-Position-Mode
// - `GET /sapi/v1/account/apiRestrictions` en `https://api.binance.com` (peso 1, firmado):
//   `ipRestrict`, `enableFutures`, `enableWithdrawals`, …
//   https://developers.binance.com/docs/wallet/account/api-key-permission
// - User data stream: `wss://fstream.binance.com/private/ws/<listenKey>`; eventos
//   `ORDER_TRADE_UPDATE`, `ALGO_UPDATE` (estados NEW, CANCELED, TRIGGERING, TRIGGERED,
//   FINISHED, REJECTED, EXPIRED; `ai` = id de la orden que nace al disparar),
//   `ACCOUNT_UPDATE`, `listenKeyExpired`. Liquidación: `c` = "autoclose-…"; ADL: "adl_autoclose".
//   https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams
//   (los campos de cada evento, del esquema oficial `binance-connector-js`,
//   clients/derivatives-trading-usds-futures/src/websocket-streams/types).
// - Testnet: REST `https://demo-fapi.binance.com`, WebSocket `wss://demo-fstream.binance.com`
//   (https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info). La
//   documentación no dice si testnet tiene las rutas `/market/` y `/private/` de mainnet.
// - Errores: https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code.
//   Un 503 "Unknown error, please check your request or try again later." deja la ejecución
//   en duda (puede haber entrado); "Service Unavailable." y −1001/−1008 son fallas seguras.

export type OrderSide = 'BUY' | 'SELL'
export type AlgoKind = 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
export type MarginType = 'isolated' | 'cross'

// ---------- REST: respuestas crudas ----------

// `POST /fapi/v1/order` con `newOrderRespType=RESULT` y `GET /fapi/v1/order`. La respuesta
// de crear no garantiza `avgPrice` ni `cumQuote` (la consulta sí): por eso son opcionales.
export interface RawOrder {
  orderId: number
  symbol: string
  status: string
  clientOrderId: string
  price: string
  avgPrice?: string
  origQty: string
  executedQty: string
  cumQty?: string
  cumQuote?: string
  timeInForce: string
  type: string
  reduceOnly: boolean
  closePosition: boolean
  side: OrderSide
  positionSide: string
  stopPrice: string
  workingType: string
  priceProtect: boolean
  origType: string
  priceMatch: string
  selfTradePreventionMode: string
  goodTillDate: number
  time?: number
  updateTime: number
}

// `POST /fapi/v1/algoOrder`, `GET /fapi/v1/algoOrder` y `GET /fapi/v1/openAlgoOrders`. Los
// `actual*` vienen sólo en las consultas.
export interface RawAlgoOrder {
  algoId: number
  clientAlgoId: string
  algoType: string
  orderType: string
  symbol: string
  side: OrderSide
  positionSide: string
  timeInForce: string
  quantity: string
  algoStatus: string
  actualOrderId?: string
  actualPrice?: string
  actualType?: string
  actualQty?: string
  triggerPrice: string
  price: string
  icebergQuantity: string | null
  selfTradePreventionMode: string
  workingType: string
  priceMatch: string
  closePosition: boolean
  priceProtect: boolean
  reduceOnly: boolean
  createTime: number
  updateTime: number
  triggerTime: number
  goodTillDate: number
}

export interface RawCancelAlgo {
  algoId: number
  clientAlgoId: string
  code: string
  msg: string
}

// `GET /fapi/v2/positionRisk`: una fila por contrato (con cantidad 0 si no hay posición).
export interface RawPositionRisk {
  symbol: string
  positionAmt: string
  entryPrice: string
  breakEvenPrice: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  maxNotionalValue: string
  marginType: string
  isolatedMargin: string
  isAutoAddMargin: string
  positionSide: string
  notional: string
  isolatedWallet: string
  updateTime: number
}

export interface RawUserTrade {
  buyer: boolean
  commission: string
  commissionAsset: string
  id: number
  maker: boolean
  orderId: number
  price: string
  qty: string
  quoteQty: string
  realizedPnl: string
  side: OrderSide
  positionSide: string
  symbol: string
  time: number
}

export interface RawIncome {
  symbol: string
  incomeType: string
  income: string
  asset: string
  info: string
  time: number
  tranId: number
  tradeId: string
}

export interface RawBalance {
  accountAlias: string
  asset: string
  balance: string
  crossWalletBalance: string
  crossUnPnl: string
  availableBalance: string
  maxWithdrawAmount: string
  marginAvailable: boolean
  updateTime: number
}

export interface RawLeverageChange {
  leverage: number
  maxNotionalValue: string
  symbol: string
}

export interface RawPositionMode {
  dualSidePosition: boolean
}

export interface RawMultiAssetsMode {
  multiAssetsMargin: boolean
}

export interface RawFeeBurn {
  feeBurn: boolean
}

export interface RawListenKey {
  listenKey: string
}

export interface RawApiRestrictions {
  ipRestrict: boolean
  createTime: number
  enableReading: boolean
  enableWithdrawals: boolean
  enableInternalTransfer: boolean
  enableMargin: boolean
  enableFutures: boolean
  permitsUniversalTransfer: boolean
  enableVanillaOptions: boolean
  enableFixApiTrade: boolean
  enableFixReadOnly: boolean
  enableSpotAndMarginTrading: boolean
  enablePortfolioMarginTrading: boolean
}

// ---------- User data stream: eventos crudos ----------

export interface RawOrderTradeUpdate {
  e: 'ORDER_TRADE_UPDATE'
  E: number
  T: number
  o: {
    s: string
    c: string
    S: OrderSide
    o: string
    f: string
    q: string
    p: string
    ap: string
    sp: string
    x: string
    X: string
    i: number
    l: string
    z: string
    L: string
    // Sólo cuando hubo un trade.
    N?: string
    n?: string
    T: number
    t: number
    b: string
    a: string
    m: boolean
    R: boolean
    wt: string
    ot: string
    ps: string
    cp: boolean
    rp: string
    pP: boolean
    si: number
    ss: number
    V: string
    pm: string
    gtd: number
    er: string
  }
}

export interface RawAlgoUpdate {
  e: 'ALGO_UPDATE'
  T: number
  E: number
  o: {
    caid: string
    aid: number
    at: string
    o: string
    s: string
    S: OrderSide
    ps: string
    f: string
    q: string
    X: string
    // La orden que nace en el motor de matching al disparar ("" antes).
    ai: string
    // Sólo cuando ya disparó y entró al motor de matching.
    ap?: string
    aq?: string
    act?: string
    tp: string
    p: string
    V: string
    wt: string
    pm: string
    cp: boolean
    pP: boolean
    R: boolean
    tt: number
    gtd: number
    rm: string
    ia: boolean
  }
}

export interface RawAccountUpdate {
  e: 'ACCOUNT_UPDATE'
  E: number
  T: number
  a: {
    m: string
    B: { a: string; wb: string; cw: string; bc: string }[]
    P: { s: string; pa: string; ep: string; bep: string; cr: string; up: string; mt: string; iw: string; ps: string }[]
    // Sólo con `m = FUNDING_FEE`.
    S?: string
  }
}

export type RawUserEvent = RawOrderTradeUpdate | RawAlgoUpdate | RawAccountUpdate

// El listenKey venció: el stream deja de mandar eventos. `E` viene como texto en el ejemplo
// de la documentación.
export interface RawListenKeyExpired {
  e: 'listenKeyExpired'
  E: number | string
  listenKey: string
}

// ---------- Formas normalizadas ----------

export interface OrderAck {
  symbol: string
  orderId: number
  clientOrderId: string
  status: string
  executedQty: number
  // 0 si no se ejecutó nada.
  avgPrice: number
  updateTime: number
}

export interface AlgoOrder {
  symbol: string
  clientAlgoId: string
  algoId: number
  type: string
  side: OrderSide
  triggerPrice: number
  quantity: number
  status: string
  // La orden de mercado que nació al disparar; null si todavía no disparó.
  actualOrderId: number | null
}

// La respuesta de crear una algorítmica trae la misma forma que la consulta.
export type AlgoAck = AlgoOrder

export interface BinancePosition {
  symbol: string
  // Con signo: positiva comprada, negativa vendida.
  amount: number
  entryPrice: number
  markPrice: number
  // null cuando Binance informa 0 (sin riesgo de liquidación calculable).
  liquidationPrice: number | null
  marginType: MarginType
  isolatedMargin: number
  leverage: number
}

export interface UserTrade {
  id: number
  orderId: number
  symbol: string
  side: OrderSide
  price: number
  qty: number
  commission: number
  commissionAsset: string
  realizedPnl: number
  time: number
}

export interface IncomeRow {
  symbol: string
  income: number
  time: number
  tranId: number
}

export interface ApiRestrictions {
  enableFutures: boolean
  enableWithdrawals: boolean
  ipRestrict: boolean
}

// ---------- User data stream: eventos normalizados ----------

export interface OrderTradeUpdate {
  symbol: string
  clientOrderId: string
  orderId: number
  side: OrderSide
  // El tipo con el que nació la orden (`STOP_MARKET` en la que dispara un stop).
  origType: string
  status: string
  execType: string
  // El trade de este evento (0 si no hubo).
  lastQty: number
  lastPrice: number
  // Promedio y cantidad acumulados de la orden.
  avgPrice: number
  cumQty: number
  commission: number
  // null si el evento no trae trade.
  commissionAsset: string | null
  realizedPnl: number
  reduceOnly: boolean
  at: number
  // Liquidación (`autoclose-…`) o ADL (`adl_autoclose`).
  liquidation: boolean
}

export interface AlgoUpdate {
  symbol: string
  clientAlgoId: string
  algoId: number
  type: string
  side: OrderSide
  triggerPrice: number
  quantity: number
  status: string
  // La orden de mercado que nació al disparar; null antes.
  triggeredOrderId: number | null
  at: number
}

export interface AccountUpdatePosition {
  symbol: string
  // Con signo; 0 cuando la posición se cerró.
  amount: number
  entryPrice: number
  marginType: MarginType
  isolatedMargin: number
  unrealizedPnl: number
}

export interface AccountUpdate {
  // `ORDER`, `FUNDING_FEE`, `MARGIN_TRANSFER`, …
  reason: string
  at: number
  positions: AccountUpdatePosition[]
}
