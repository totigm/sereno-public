// El exchange real del motor: la misma forma que el simulador (`EngineExchange`) sobre la
// cuenta de futuros USDT-M de Binance. El motor no sabe si es real.
//
// - Abre a mercado en margen aislado, sólo donde Binance no tiene posición y sólo si el
//   gating lo permite (`openings`); todo lo demás (stops, cierres, funding) sigue aunque la
//   operación esté apagada: eso sólo reduce riesgo.
// - Stops y take profits algorítmicos `reduceOnly` por la cantidad del bot (`Protector`). Si
//   el stop no se puede poner, cierra a mercado en el acto y el motor lo recibe como
//   `unprotected`.
// - Lo que Binance resuelve solo (disparos, liquidaciones) llega por la cuenta, se encola y
//   el motor lo recibe con el próximo `processTick`, igual que con el simulador; el funding,
//   con `applyFunding`. Si el bot ya había cerrado una parte a mercado, el cierre que llega
//   la incluye: el motor recibe siempre la posición entera.
// - Una apertura que quedó en duda (Binance no la confirmó o su fill no se pudo leer) se
//   vuelve a consultar antes de abrir otra vez en la moneda y en cada vuelta de la
//   reconciliación; si Binance la llenó, se cierra en el acto (`DoubtfulOpens`). Con el ack
//   de Binance en la mano, en cambio, vale el ack: la posición es del bot.
// - Una posición del bot que Binance dejó de mostrar y cuyo cierre todavía no aparece no
//   recibe órdenes nuevas: cualquier orden ahí podría tocar lo que Toti abra en la moneda.
//   Con una sola vuelta de la reconciliación queda en duda y conserva su stop (la foto pudo
//   venir atrasada); con la segunda seguida se da por desaparecida y sus algos se cancelan.
//   Si Binance la vuelve a mostrar con al menos la cantidad del bot y nada prueba que se
//   cerró, se repone la protección (`vanishing.ts`). Mientras, la reconciliación busca el cierre.
// - Antes de cerrar a mercado se comprueba que ningún stop o take profit del bot haya
//   disparado ya (`fired-trigger.ts`): con Toti en la moneda, un cierre de más se ejecutaría
//   contra lo suyo. Si disparó, el cierre es ése. Sin user data stream la cuenta no puede
//   descartar a Toti y se pregunta siempre por REST.
// - Después de un cierre a medias, stop y take profit pasan a lo que le queda al bot; si
//   Binance no toma el achicado, la reconciliación lo vuelve a intentar (`ensureProtected`,
//   `ensureTakeProfit`): uno por más, disparado, cerraría también lo que Toti tenga ahí.
// - Los números (precio, comisión, pnl realizado, funding) son los de Binance.
// - Vive lo que vive la sesión en el proceso: rehacer el motor (ajustes de riesgo, contratos)
//   lo apunta a los contratos y la comisión nuevos (`retarget`) y el motor nuevo retoma sus
//   abiertas sobre lo que el adaptador ya sabía (aperturas en duda, cierres a medias,
//   desaparecidas, diferencias con Toti, algos puestos, cierres y funding encolados).
// - Qué posición es del bot lo decide su registro (la base, a través del motor), nunca
//   Binance: con una cantidad distinta allá, el bot gestiona sólo la suya.

import type { CloseReason, Fill, FundingEvent, MarkTick, SymbolInfo } from '@sereno/core'
import { OrderRejectedError } from '@sereno/core/src/exchange/errors'
import { closingSide, positionSideOf } from '@sereno/core/src/exchange/sides'
import type {
  Balance,
  EngineExchange,
  ExchangePosition,
  FundingApplied,
  MarketOrder,
  Order,
  OrderId,
  PositionState,
  Prices,
  RestoreResult,
  StopOrder,
  TriggeredOrder,
  Unsubscribe,
} from '@sereno/core/src/exchange/types'
import { liquidationPrice } from '@sereno/core/src/risk/liquidation'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { Logger } from 'pino'
import { formatQty } from '../binance/precision'
import type { BinanceTradeRest } from '../binance/trade-rest'
import { classifyBinanceError, isUnknownOutcome } from '../binance/trade-errors'
import type { OrderAck } from '../binance/trade-types'
import type { Clock } from '../live/timers'
import { silentLogger } from '../logger'
import { AccountStoppedError, type RealAccount, type TriggeredFill } from './account'
import { BotBook } from './bot-book'
import { parseClientId, type ClientIds } from './client-id'
import { Closer } from './closer'
import { DoubtfulOpens } from './doubtful-opens'
import { FillReader } from './fill-reader'
import { firedTrigger } from './fired-trigger'
import { closedQtyPhrase, coinOf, fatalOrSame, foreignPhrase, isBinanceFailure, type NoteSink, type RealNote } from './notes'
import { adverseCost, engineFill, realizedOf, triggeredOrder, withPartial, type PendingClose } from './pending-close'
import { Protector, type ProtectiveKind } from './protector'
import { DEFAULT_RETRY, withRetries, type RetryPolicy } from './retry'
import { VanishedPositions, type VanishedProtection } from './vanishing'

export type { PendingClose } from './pending-close'
export type { RealNote } from './notes'

export type ExchangeTradeApi = Pick<BinanceTradeRest, 'marketOrder' | 'algoOrder' | 'cancelAlgo' | 'openAlgoOrders' | 'queryAlgo' | 'userTrades' | 'setIsolated' | 'setLeverage' | 'positionRisk'>
export type ExchangeAccount = Pick<RealAccount, 'position' | 'botAlgos' | 'awaitOrderFill' | 'onTriggered' | 'onFatal' | 'streamUp'>

// Lo decide el gating de la sesión real; el adaptador sólo lo consulta antes de abrir.
export type OpeningsGate = { allowed: true } | { allowed: false; detail: string }

// Lo que tuvo que hacer `ensureProtected`: reponer el stop que faltaba, llevarlo a la cantidad
// del bot, cancelar uno por otra cantidad que sobraba junto al bueno o, si Binance no tomó
// ninguno, cerrar la posición (`unprotected`).
export type StopRepair = 'replaced' | 'resized' | 'trimmed' | 'closed'

// Lo que hay en Binance de una moneda del bot que la reconciliación ve del mismo lado.
// `foreign`: la del bot ya había desaparecido y lo de ahora no tiene su cantidad (es de Toti).
export type PresentOutcome = 'present' | 'reappeared' | 'foreign'

// Lo que el motor fija al crearse y puede cambiar al rehacerlo.
export interface ExchangeContracts {
  infos: Record<string, SymbolInfo>
  takerFeeRate: number
}

// Lo que encontró `reconcileAtStart` para las abiertas de la base: las que Binance ya cerró
// (se restauran con su cierre encolado, sin comparar con lo que Binance muestra ahora, que
// puede ser de Toti) y las que no aparecen sin cierre a la vista todavía (quedan en duda: la
// primera vuelta de la reconciliación lo confirma o lo descarta).
export interface AtStart {
  pendingCloses: ReadonlyMap<string, PendingClose>
  vanished: readonly string[]
}

export interface BinanceFuturesExchangeOptions {
  account: ExchangeAccount
  trade: ExchangeTradeApi
  ids: ClientIds
  infos: Record<string, SymbolInfo>
  clock: Clock
  // La billetera de la sesión al crear el adaptador (capital más lo realizado).
  initialBalance: number
  openings: () => OpeningsGate
  onNote: (note: RealNote) => void
  retry?: RetryPolicy
  // Para estimar la comisión antes de abrir (y si Binance no informa un trade).
  takerFeeRate?: number
  atStart?: AtStart
  logger?: Logger
}

// "Order would immediately trigger."
const WOULD_TRIGGER = -2021

export class BinanceFuturesExchange implements EngineExchange {
  readonly protectiveOrders = 'overlapping'
  private readonly account: ExchangeAccount
  private readonly trade: ExchangeTradeApi
  private readonly ids: ClientIds
  private infos: Record<string, SymbolInfo>
  private readonly clock: Clock
  private readonly openings: () => OpeningsGate
  private readonly onNote: NoteSink
  private readonly retry: RetryPolicy
  private takerFeeRate: number
  private readonly logger: Logger
  private readonly book: BotBook
  private readonly protector: Protector
  private readonly closer: Closer
  private readonly fills: FillReader
  private readonly doubts: DoubtfulOpens
  private readonly leverages = new Map<string, number>()
  // Monedas con un cierre a mercado del bot en vuelo: la reconciliación no las toca.
  private readonly closing = new Set<string>()
  // Monedas donde la cantidad en Binance no es la del bot (Toti sumó o restó a mano).
  private readonly mismatched = new Set<string>()
  // Posiciones del bot que Binance dejó de mostrar, sin cierre encontrado todavía.
  private readonly vanished: VanishedPositions
  private readonly startCloses: Map<string, PendingClose>
  private readonly startVanished: Set<string>
  // Rechazos ya avisados: el motor reintenta con cada tick y el aviso va una vez por racha.
  private readonly noted = new Set<string>()
  private readonly markListeners = new Set<(tick: MarkTick) => void>()
  private readonly fundingListeners = new Set<(ev: FundingEvent) => void>()
  private readonly unsubscribe: (() => void)[]

  constructor(opts: BinanceFuturesExchangeOptions) {
    this.account = opts.account
    this.trade = opts.trade
    this.ids = opts.ids
    this.infos = opts.infos
    this.clock = opts.clock
    this.openings = opts.openings
    this.onNote = (note) => {
      try {
        opts.onNote(note)
      } catch (err) {
        this.logger.error({ err }, 'BinanceFuturesExchange: falló quien escucha las notas')
      }
    }
    this.retry = opts.retry ?? DEFAULT_RETRY
    this.takerFeeRate = opts.takerFeeRate ?? DEFAULT_SETTINGS.risk.takerFeeRate
    this.logger = opts.logger ?? silentLogger
    this.book = new BotBook(opts.initialBalance)
    this.vanished = new VanishedPositions(opts.clock)
    this.startCloses = new Map(opts.atStart?.pendingCloses)
    this.startVanished = new Set(opts.atStart?.vanished)
    const common = { ids: opts.ids, infoOf: (symbol: string) => this.infoOf(symbol), clock: opts.clock, onNote: this.onNote }
    this.protector = new Protector({ ...common, trade: opts.trade, account: opts.account, delaysMs: this.retry.delaysMs, logger: this.logger })
    this.fills = new FillReader({ account: opts.account, trade: opts.trade, fillTimeoutMs: this.retry.fillTimeoutMs, takerFeeRate: () => this.takerFeeRate, onNote: this.onNote, logger: this.logger })
    this.closer = new Closer({ ...common, trade: opts.trade, retry: this.retry, book: this.book, fills: this.fills, algoIds: (symbol) => this.protector.idsOf(symbol) })
    const orphans = new Closer({ ...common, trade: opts.trade, retry: this.retry, book: this.book, fills: this.fills, algoIds: () => [] })
    this.doubts = new DoubtfulOpens({ fills: this.fills, closer: orphans, clock: opts.clock, onNote: this.onNote, logger: this.logger })
    this.unsubscribe = [
      opts.account.onTriggered((t) => this.onTriggered(t)),
      // Lo fatal que llega por el stream (una comisión en otra moneda) apaga la sesión igual.
      opts.account.onFatal((err) => this.onNote({ kind: 'fatal', symbol: null, phrase: err.message })),
    ]
  }

  // ---------- Abrir ----------

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.infoOf(symbol)
    if (this.book.has(symbol)) throw new Error(`ya hay una posición del bot en ${symbol}`)
    // Antes que el gating: cerrar lo que dejó una apertura en duda sólo reduce riesgo.
    await this.settleDoubt(symbol)
    this.assertCanOpen(symbol)
    if (!this.account.streamUp) await this.assertNoPositionByRest(symbol)
    try {
      await withRetries(this.clock, this.retry.delaysMs, () => this.trade.setIsolated(symbol))
      await withRetries(this.clock, this.retry.delaysMs, () => this.trade.setLeverage(symbol, leverage))
    } catch (err) {
      throw this.rejected(symbol, 'leverage', err)
    }
    this.cleared(symbol, 'leverage')
    this.leverages.set(symbol, leverage)
  }

  async placeMarketOrder(req: MarketOrder): Promise<Fill> {
    const { symbol } = req
    if (req.reduceOnly) throw new Error(`el exchange real cierra con closePosition, no con una orden reduceOnly (${symbol})`)
    const info = this.infoOf(symbol)
    if (this.book.has(symbol)) throw new Error(`ya hay una posición del bot en ${symbol}`)
    this.assertCanOpen(symbol)
    const leverage = this.leverages.get(symbol)
    if (leverage === undefined) throw new Error(`sin apalancamiento fijado en ${symbol}: setLeverage va antes de abrir`)
    const { last } = this.book.pricesOf(symbol)
    const quantity = formatQty(req.qty, info.stepSize)
    if (!(Number(quantity) > 0)) throw new RangeError(`cantidad inválida en ${symbol}: ${req.qty}`)
    const notional = Number(quantity) * last
    const required = notional / leverage + notional * this.takerFeeRate
    const { available } = this.book.balance()
    if (required > available) throw new OrderRejectedError('insufficient_margin', `saldo insuficiente de la sesión real para abrir ${symbol}: hacen falta ${required} y hay ${available}`)

    const clientOrderId = this.ids.next('o')
    const side = positionSideOf(req.side)
    const doubt = { clientOrderId, side, sentAt: this.clock.now() }
    let ack: OrderAck | null = null
    // Una sola vez: otra con el mismo id podría ejecutarse junto a una que Binance llena tarde
    // (cabecera de `trade-rest.ts`). Lo que falla vuelve al motor, que reintenta con otro id.
    try {
      ack = await this.trade.marketOrder({ symbol, side: req.side === 'buy' ? 'BUY' : 'SELL', quantity, reduceOnly: false, clientOrderId })
    } catch (err) {
      // En duda aun después de consultar por el id: la lectura del fill vuelve a preguntar y,
      // si tampoco la encuentra, queda como apertura en duda.
      if (!isUnknownOutcome(err)) throw this.rejected(symbol, 'open', err)
    }
    let fill
    try {
      fill = await this.fills.read(symbol, clientOrderId, () => 0, ack)
    } catch (err) {
      if (!(err instanceof AccountStoppedError)) this.doubts.remember(symbol, doubt)
      throw err
    }
    if (fill === null) {
      this.doubts.remember(symbol, doubt)
      throw new OrderRejectedError('exchange_rejected', `Binance no tiene la apertura ${clientOrderId} en ${symbol}; si la registra tarde, la cierro`, 'Binance no confirmó la orden')
    }
    if (fill.qty <= 0) throw new OrderRejectedError('exchange_rejected', `Binance no ejecutó la apertura ${clientOrderId} en ${symbol}`, 'Binance rechazó la orden')
    this.cleared(symbol, 'open')
    const entryNotional = fill.avgPrice * fill.qty
    this.book.add({
      symbol,
      side,
      leverage,
      margin: entryNotional / leverage,
      notional: entryNotional,
      qty: fill.qty,
      entryPrice: fill.avgPrice,
      openedAt: fill.at,
      liquidationPrice: liquidationPrice(side, fill.avgPrice, leverage, info.mmr),
      feesPaid: fill.commission,
      fundingPaid: 0,
    })
    this.book.realize(realizedOf(fill))
    return engineFill(symbol, req.side, fill, adverseCost(req.side, fill.avgPrice, last, fill.qty))
  }

  // ---------- Proteger ----------

  placeStopMarket(req: StopOrder): Promise<OrderId> {
    return this.protect('stop', req)
  }

  placeTakeProfitMarket(req: StopOrder): Promise<OrderId> {
    return this.protect('take_profit', req)
  }

  async cancelOrder(symbol: string, orderId: OrderId): Promise<void> {
    await this.protector.cancel(symbol, orderId)
  }

  // Que Binance tenga el último stop del bot por lo que le queda al bot: lo repone si no hay
  // ninguno (lo cancelaron a mano), lo ajusta si es por otra cantidad (no se pudo achicar
  // después de un cierre a medias) y cancela uno por otra cantidad que sobra. Si no hay ninguno y no se puede poner, la posición se
  // cierra como `unprotected`. null si no hizo falta nada (o no se pudo ajustar y el viejo
  // sigue cubriendo). Si no se puede saber qué hay en Binance, tira sin tocar nada.
  async ensureProtected(symbol: string): Promise<StopRepair | null> {
    const position = this.book.get(symbol)
    const last = this.protector.lastStop(symbol)
    if (!position || last === null || this.book.hasClose(symbol) || this.blocked(symbol)) return null
    const req = { symbol, side: closingSide(position.side), qty: this.openQty(symbol), triggerPrice: last.price }
    const result = await this.protector.ensureStop(req)
    switch (result.kind) {
      case 'live':
        return null
      case 'placed':
        return 'replaced'
      case 'resized':
        return 'resized'
      case 'trimmed':
        return 'trimmed'
      case 'oversized':
        this.logger.warn({ symbol, qty: req.qty, err: messageOf(result.error) }, 'BinanceFuturesExchange: no pude llevar el stop a la cantidad del bot; el anterior sigue cubriendo y lo reintento')
        return null
      case 'failed':
        if (!(await this.stopFailed(position, last.price, result.error, 'uncovered'))) throw result.error
        return 'closed'
    }
  }

  // Que el take profit del bot sea por lo que le queda al bot (un cierre a medias que no lo
  // pudo achicar). true si lo ajustó; si Binance no toma el nuevo, queda el anterior y la
  // próxima vuelta lo reintenta. Si no se puede saber qué hay en Binance, tira.
  async ensureTakeProfit(symbol: string): Promise<boolean> {
    const position = this.book.get(symbol)
    if (!position || this.book.hasClose(symbol) || this.blocked(symbol)) return false
    const qty = this.openQty(symbol)
    const result = await this.protector.ensureTakeProfit({ symbol, side: closingSide(position.side), qty })
    if (result.kind === 'oversized') {
      this.logger.warn({ symbol, qty, err: messageOf(result.error) }, 'BinanceFuturesExchange: no pude llevar el take profit a la cantidad del bot; lo reintento')
      return false
    }
    return result.kind === 'resized'
  }

  // Cancela todo algo del bot (tope de pérdida, interruptor).
  cancelAllBot(): Promise<void> {
    return this.protector.cancelAll()
  }

  lastStop(symbol: string): { price: number; qty: number } | null {
    return this.protector.lastStop(symbol)
  }

  // ---------- Cerrar ----------

  // El motivo es del motor (lo guarda en la posición); a Binance no le cambia nada.
  async closePosition(symbol: string, _reason: CloseReason): Promise<Fill> {
    const queued = this.book.takeClose(symbol)
    if (queued) return this.consumeClose(symbol, queued)
    const position = this.book.require(symbol)
    this.assertPresent(symbol)
    let closed
    this.closing.add(symbol)
    try {
      const fired = await this.firedBeforeClose(position)
      if (fired) return await this.consumeClose(symbol, fired)
      closed = await this.closer.close(position)
    } catch (err) {
      await this.resizeAfterPartial(position)
      throw this.rejected(symbol, 'close', err)
    } finally {
      this.closing.delete(symbol)
    }
    this.book.settle(symbol, realizedOf(closed.fill))
    await this.afterClose(symbol)
    return engineFill(symbol, closingSide(position.side), closed.fill, closed.slippageCost)
  }

  // Un cierre que resolvió Binance (o la reconciliación): lo recibe el motor con el próximo
  // tick, o con `closePosition` si lo pide antes.
  queueClose(symbol: string, close: PendingClose): void {
    if (!this.book.has(symbol)) {
      this.logger.warn({ symbol, reason: close.reason }, 'BinanceFuturesExchange: cierre de una moneda donde el bot no tiene posición; se ignora')
      return
    }
    if (!this.book.queueClose(symbol, close)) this.logger.info({ symbol, reason: close.reason }, 'BinanceFuturesExchange: ya había un cierre encolado en la moneda; manda el primero')
  }

  hasPendingClose(symbol: string): boolean {
    return this.book.hasClose(symbol)
  }

  isClosing(symbol: string): boolean {
    return this.closing.has(symbol)
  }

  // La cantidad del bot que sigue abierta en Binance: la suya menos lo que ya cerró a mercado
  // de un cierre que quedó a medias.
  openQty(symbol: string): number {
    const position = this.book.get(symbol)
    return position ? position.qty - this.closer.closedQty(symbol) : 0
  }

  // Una vuelta de la reconciliación no vio la posición del bot en Binance ni su cierre en los
  // trades. La primera queda en duda (sin órdenes nuevas, con su stop); la segunda seguida la
  // da por desaparecida y cancela sus algos. true si quedó desaparecida.
  noteMissing(symbol: string): boolean {
    if (!this.book.has(symbol)) return false
    if (this.vanished.isGone(symbol)) return true
    if (!this.vanished.missing(symbol)) return false
    this.vanish(symbol)
    return true
  }

  // Binance muestra del mismo lado `amount` en una moneda del bot. Una duda se olvida. Una
  // desaparecida que vuelve con al menos lo del bot (con Toti en la moneda, más) era una foto
  // atrasada y recupera su protección; quien llama ya comprobó que nada la cerró (`closedUnderneath`).
  // Con menos, algo se cerró y el cierre se sigue buscando.
  async notePresent(symbol: string, amount: number): Promise<PresentOutcome> {
    if (!this.vanished.isGone(symbol)) {
      this.vanished.seen(symbol)
      return 'present'
    }
    if (Math.abs(amount) < this.openQty(symbol) - this.infoOf(symbol).stepSize / 2) return 'foreign'
    const protection = this.vanished.seen(symbol)
    if (protection) await this.reprotect(symbol, protection)
    return 'reappeared'
  }

  isVanished(symbol: string): boolean {
    return this.vanished.isGone(symbol)
  }

  // Las aperturas en duda, consultadas otra vez (la reconciliación, en cada vuelta). Lo que
  // falle en una moneda queda para la próxima.
  async resolveDoubtfulOpens(): Promise<void> {
    for (const symbol of this.doubts.symbols()) {
      try {
        await this.doubts.resolve(symbol)
      } catch (err) {
        this.logger.warn({ symbol, err: messageOf(err) }, 'BinanceFuturesExchange: no pude resolver la apertura en duda; reintento en la próxima vuelta')
      }
    }
  }

  // Los stops y take profits del bot en la moneda que conoce este proceso (puestos o vistos, y
  // los de una posición desaparecida).
  algoIdsOf(symbol: string): string[] {
    return [...new Set([...this.protector.idsOf(symbol), ...(this.vanished.protectionOf(symbol)?.algoIds ?? [])])]
  }

  contract(symbol: string): SymbolInfo {
    return this.infoOf(symbol)
  }

  // ---------- Lo que pasó en Binance, hacia el motor ----------

  processTick(tick: MarkTick): TriggeredOrder[] {
    this.setPrices(tick.symbol, { mark: tick.markPrice, last: tick.lastPrice })
    const triggered: TriggeredOrder[] = []
    const queued = this.book.has(tick.symbol) ? this.book.takeClose(tick.symbol) : undefined
    if (queued) {
      const { position, close, slippageCost } = this.settleQueued(tick.symbol, queued)
      triggered.push(triggeredOrder(position, close, tick.markPrice, this.infoOf(tick.symbol).liquidationFee, slippageCost))
      this.protector.retire(tick.symbol)
    }
    void this.protector.sweep()
    for (const cb of this.markListeners) cb(tick)
    return triggered
  }

  queueFunding(applied: FundingApplied): void {
    this.book.queueFunding(applied)
  }

  // Entrega lo que Binance cobró o pagó en la moneda (el monto es el de Binance; la tasa del
  // evento sólo se valida).
  applyFunding(ev: FundingEvent): FundingApplied[] {
    if (!(Number.isFinite(ev.rate) && Number.isFinite(ev.markPrice) && ev.markPrice > 0)) {
      throw new RangeError(`evento de funding inválido en ${ev.symbol}: tasa ${ev.rate}, marca ${ev.markPrice}`)
    }
    const applied: FundingApplied[] = []
    for (const f of this.book.takeFunding(ev.symbol)) {
      if (!this.book.has(f.symbol)) {
        this.logger.warn({ symbol: f.symbol, amount: f.amount, at: f.at }, 'BinanceFuturesExchange: funding de una posición que ya se cerró; no llega al motor')
        continue
      }
      this.book.fund(f)
      applied.push(f)
    }
    for (const cb of this.fundingListeners) cb(ev)
    return applied
  }

  // El motor se rehace con otros contratos o comisión: el adaptador sigue con todo lo que sabe.
  // Devuelve cómo volver a lo anterior, por si el motor nuevo no se puede retomar.
  retarget(next: ExchangeContracts): () => void {
    const previous: ExchangeContracts = { infos: this.infos, takerFeeRate: this.takerFeeRate }
    this.infos = next.infos
    this.takerFeeRate = next.takerFeeRate
    return () => {
      this.infos = previous.infos
      this.takerFeeRate = previous.takerFeeRate
    }
  }

  // La abierta que el motor retoma de la base: el bot gestiona esta cantidad. Si Binance tiene
  // otra del mismo lado, la diferencia es de Toti y se avisa. Una que el adaptador ya tiene es
  // la de un motor que se rehízo: toma el registro del motor y conserva lo que ya sabía de ella
  // (lo cerrado a medias, su cierre encolado, si desapareció o si no coincide con Binance).
  restorePosition(state: PositionState): RestoreResult {
    const info = this.infoOf(state.symbol)
    if (this.book.has(state.symbol)) {
      this.book.replace(state)
      return { liquidationRecalculated: null }
    }
    this.book.add(state)
    this.leverages.set(state.symbol, state.leverage)
    const startClose = this.startCloses.get(state.symbol)
    this.startCloses.delete(state.symbol)
    if (startClose) {
      this.book.queueClose(state.symbol, startClose)
      return { liquidationRecalculated: null }
    }
    if (this.startVanished.delete(state.symbol)) {
      this.vanished.doubt(state.symbol)
      return { liquidationRecalculated: null }
    }
    const live = this.account.position(state.symbol)
    if (live === null) return { liquidationRecalculated: null }
    const amount = Math.abs(live.amount)
    const sameSide = positionSideOf(live.amount > 0 ? 'buy' : 'sell') === state.side
    if (!sameSide || Math.abs(amount - state.qty) > info.stepSize / 2) this.markMismatch(state.symbol, live.amount, state.qty)
    if (!sameSide || live.liquidationPrice === null || Math.abs(live.liquidationPrice - state.liquidationPrice) <= info.tickSize) return { liquidationRecalculated: null }
    return { liquidationRecalculated: { from: state.liquidationPrice, to: live.liquidationPrice } }
  }

  // La cantidad en Binance no es la del bot: gestiona sólo la suya y no abre más ahí hasta
  // que la moneda quede en cero. Se avisa una vez.
  markMismatch(symbol: string, binanceAmount: number, botQty: number): void {
    if (this.mismatched.has(symbol)) return
    this.mismatched.add(symbol)
    const phrase = `Binance tiene ${Math.abs(binanceAmount)} ${coinOf(symbol)} y yo ${botQty}: manejo sólo lo mío y no abro más ahí hasta que quede en cero.`
    this.onNote({ kind: 'mismatch', symbol, phrase, data: { binanceAmount, botQty } })
  }

  // ---------- Lectura ----------

  setPrices(symbol: string, prices: Prices): void {
    this.book.setPrices(symbol, prices)
  }

  async getPositions(): Promise<ExchangePosition[]> {
    return this.book.views()
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    return this.account.botAlgos(symbol).map((a) => ({
      id: a.clientAlgoId,
      symbol: a.symbol,
      type: a.type === 'TAKE_PROFIT_MARKET' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
      side: a.side === 'BUY' ? 'buy' : 'sell',
      stopPrice: a.triggerPrice,
    }))
  }

  async getBalance(): Promise<Balance> {
    return this.book.balance()
  }

  onMarkPrice(cb: (tick: MarkTick) => void): Unsubscribe {
    this.markListeners.add(cb)
    return () => this.markListeners.delete(cb)
  }

  onFunding(cb: (ev: FundingEvent) => void): Unsubscribe {
    this.fundingListeners.add(cb)
    return () => this.fundingListeners.delete(cb)
  }

  // Deja de escuchar la cuenta (el motor se rehace sobre un adaptador nuevo).
  detach(): void {
    for (const off of this.unsubscribe.splice(0)) off()
  }

  // ---------- Internos ----------

  // El gating primero; después la propiedad: el bot no abre donde Binance tiene una posición
  // (de Toti, o lo que quedó de una moneda donde las cantidades dejaron de coincidir) hasta
  // que la moneda quede en cero.
  private assertCanOpen(symbol: string): void {
    const gate = this.openings()
    if (!gate.allowed) throw new OrderRejectedError('opening_disabled', `la operación real no abre: ${gate.detail}`, gate.detail)
    if (this.doubts.has(symbol)) throw doubtRejection(symbol, 'pending')
    const live = this.account.position(symbol)
    if (live === null) {
      this.mismatched.delete(symbol)
      this.cleared(symbol, 'foreign')
      return
    }
    this.foreign(symbol, live.amount)
  }

  // Sin user data stream la cuenta puede no haber visto una posición que Toti acaba de abrir:
  // antes de fijarle margen y apalancamiento (que también son los de su posición) se le
  // pregunta a Binance. Con el stream conectado alcanza con la cuenta.
  private async assertNoPositionByRest(symbol: string): Promise<void> {
    let positions
    try {
      positions = await this.trade.positionRisk()
    } catch (err) {
      throw this.rejected(symbol, 'leverage', err)
    }
    const amount = positions.find((p) => p.symbol === symbol)?.amount ?? 0
    if (amount !== 0) this.foreign(symbol, amount)
  }

  private foreign(symbol: string, amount: number): never {
    const phrase = foreignPhrase(symbol)
    if (!this.noted.has(`${symbol}:foreign`)) {
      this.noted.add(`${symbol}:foreign`)
      this.onNote({ kind: 'foreign_position', symbol, phrase, data: { amount } })
    }
    throw new OrderRejectedError('foreign_position', `${symbol}: ${phrase}`, phrase)
  }

  // Una apertura anterior en duda en la moneda se resuelve antes de abrir otra: si Binance la
  // llenó, se cierra y esta apertura espera al próximo intento (la cuenta todavía la puede
  // mostrar y no es de Toti).
  private async settleDoubt(symbol: string): Promise<void> {
    if (!this.doubts.has(symbol)) return
    let outcome
    try {
      outcome = await this.doubts.resolve(symbol)
    } catch (err) {
      throw this.rejected(symbol, 'open', err)
    }
    if (outcome !== 'clear') throw doubtRejection(symbol, outcome)
  }

  private async protect(kind: ProtectiveKind, req: StopOrder): Promise<OrderId> {
    const { symbol } = req
    if (!('qty' in req)) throw new Error(`el exchange real nunca usa closePosition: el ${kind} de ${symbol} lleva la cantidad del bot`)
    const position = this.book.require(symbol)
    if (this.book.hasClose(symbol)) throw new Error(`la posición del bot en ${symbol} ya se cerró en Binance; no la protejo`)
    this.assertPresent(symbol)
    // La cantidad es la que le queda al bot, aunque Binance tenga otra.
    const request = { symbol, side: req.side, qty: this.openQty(symbol), triggerPrice: req.stopPrice }
    try {
      const id = await this.protector.place(kind, request)
      this.cleared(symbol, kind)
      return id
    } catch (err) {
      const reported = this.rejected(symbol, kind, err)
      if (kind === 'stop') await this.stopFailed(position, req.stopPrice, err, 'unknown')
      throw reported
    }
  }

  // Binance no tomó el stop después de los reintentos: sin stop no queda nada abierto. Se
  // cierra a mercado ya y el motor lo recibe como `unprotected` con el próximo tick. No
  // cuentan −2021 (dispararía en el acto: el respaldo del motor cierra con este mismo
  // tick), un fatal (la sesión se apaga cerrando todo) ni un error nuestro. Tampoco cierra
  // si sigue puesto un stop del bot (falló mover el de un trailing: el viejo cubre y el motor
  // reintenta). `cover` dice si ya se sabe que no hay ninguno. true si cerró.
  private async stopFailed(position: PositionState, stopPrice: number, cause: unknown, cover: 'uncovered' | 'unknown'): Promise<boolean> {
    if (!isBinanceFailure(cause)) return false
    const { kind, code, message } = classifyBinanceError(cause)
    if (kind === 'fatal' || code === WOULD_TRIGGER) return false
    const { symbol } = position
    if (cover === 'unknown' && (await this.stillCovered(symbol))) {
      this.logger.warn({ symbol, stopPrice, err: message }, 'BinanceFuturesExchange: no pude mover el stop; el anterior sigue puesto y reintento con el próximo tick')
      return false
    }
    let closed
    this.closing.add(symbol)
    try {
      // Un take profit que ya disparó la cerró: el motor lo recibe con el próximo tick.
      const fired = await this.firedBeforeClose(position)
      if (fired) {
        this.book.queueClose(symbol, fired)
        await this.afterClose(symbol)
        return true
      }
      closed = await this.closer.close(position)
    } catch (err) {
      this.logger.error({ symbol, err: messageOf(err) }, 'BinanceFuturesExchange: no pude poner el stop ni cerrar la posición; reintento con el próximo tick')
      return false
    } finally {
      this.closing.delete(symbol)
    }
    this.book.queueClose(symbol, { reason: 'unprotected', fill: closed.fill, triggerPrice: stopPrice, orderId: closed.orderId })
    const phrase = `No pude poner el stop en ${coinOf(symbol)}: la cerré para no dejarla sin protección.`
    this.onNote({ kind: 'unprotected', symbol, phrase, data: { stopPrice, reason: message } })
    await this.afterClose(symbol)
    return true
  }

  // ¿Sigue puesto un stop del bot? REST manda; si no responde, lo que sabe este proceso (un
  // stop anterior que puso y nadie le dijo que se fue).
  private async stillCovered(symbol: string): Promise<boolean> {
    try {
      return await this.protector.hasLiveStop(symbol)
    } catch (err) {
      this.logger.warn({ symbol, err: messageOf(err) }, 'BinanceFuturesExchange: no pude consultar los stops en Binance; uso lo que sé')
      return this.protector.lastStop(symbol) !== null
    }
  }

  // El cierre de un stop o take profit del bot que ya disparó en Binance y todavía no llegó;
  // null si ninguno disparó (`fired-trigger.ts`). Lo que el bot ya cerró a mercado no cuenta
  // como diferencia: Binance sigue mostrándolo hasta que el cierre termina. Sin user data
  // stream la cuenta no vio lo que Toti sumó ni el disparo, y ni una foto por REST de la
  // posición los separa (Toti sumó lo mismo que cerró el stop: la moneda muestra la cantidad
  // del bot): se pregunta siempre por los algos del bot.
  private firedBeforeClose(position: PositionState): Promise<PendingClose | null> {
    const { symbol } = position
    const live = this.account.position(symbol)
    const remaining = this.openQty(symbol)
    const shown = live === null ? 0 : live.amount * (position.side === 'long' ? 1 : -1)
    const differs = live !== null && Math.abs(shown - remaining) > this.infoOf(symbol).stepSize / 2
    const othersInCoin = !this.account.streamUp || this.mismatched.has(symbol) || differs
    return firedTrigger(
      { book: this.book, trade: this.trade, clock: this.clock, fillTimeoutMs: this.retry.fillTimeoutMs },
      { symbol, side: position.side, live: this.protector.liveTriggers(symbol), algoIds: this.protector.idsOf(symbol), othersInCoin },
    )
  }

  // Un cierre encolado que el motor pide con `closePosition` antes del tick.
  private async consumeClose(symbol: string, queued: PendingClose): Promise<Fill> {
    const { position, close, slippageCost } = this.settleQueued(symbol, queued)
    await this.afterClose(symbol)
    return engineFill(symbol, closingSide(position.side), close.fill, slippageCost)
  }

  // Un cierre que resolvió Binance deja la posición, con lo que el bot ya había cerrado a
  // mercado de ella: el motor recibe la cantidad, la comisión y el pnl de la posición entera.
  // Si aun así no es la cantidad del bot (le faltó, o se llevó también lo de Toti), se avisa.
  private settleQueued(symbol: string, queued: PendingClose): { position: ExchangePosition; close: PendingClose; slippageCost: number } {
    const { close, slippageCost } = withPartial(queued, this.closer.takePartial(symbol))
    const botQty = this.book.require(symbol).qty
    if (Math.abs(botQty - close.fill.qty) > this.infoOf(symbol).stepSize / 2) {
      this.onNote({ kind: 'mismatch', symbol, phrase: closedQtyPhrase(close.reason, symbol, close.fill.qty, botQty), data: { filled: close.fill.qty, botQty } })
    }
    this.vanished.forget(symbol)
    return { position: this.book.settle(symbol, realizedOf(close.fill)), close, slippageCost }
  }

  // Un cierre `c` que quedó a medias: stop y take profit pasan a lo que le queda al bot.
  private async resizeAfterPartial(position: PositionState): Promise<void> {
    const remaining = this.openQty(position.symbol)
    if (this.closer.closedQty(position.symbol) <= 0 || remaining <= 0) return
    await this.protector.resize(position.symbol, closingSide(position.side), remaining)
  }

  // Los algos hermanos de lo que se cerró sobran: se cancelan ahora (lo que falle, después).
  private async afterClose(symbol: string): Promise<void> {
    this.protector.retire(symbol)
    await this.protector.sweep()
  }

  private onTriggered(t: TriggeredFill): void {
    const position = this.book.get(t.symbol)
    if (!position) {
      this.logger.warn({ symbol: t.symbol, clientAlgoId: t.clientAlgoId }, 'BinanceFuturesExchange: disparo en una moneda donde el bot no tiene posición; se ignora')
      return
    }
    const reason = t.liquidation ? 'liquidation' : parseClientId(t.clientAlgoId)?.kind === 't' ? 'take_profit' : 'stop'
    const triggerPrice = t.liquidation ? position.liquidationPrice : (this.protector.info(t.clientAlgoId)?.triggerPrice ?? t.fill.avgPrice)
    this.queueClose(t.symbol, { reason, fill: t.fill, triggerPrice, orderId: t.clientAlgoId })
  }

  // Un rechazo de Binance: se avisa una vez por racha y, al abrir, sale como el rechazo del
  // motor. Lo fatal se avisa y sale como error; un error nuestro sale tal cual.
  private rejected(symbol: string, what: string, err: unknown): unknown {
    if (!isBinanceFailure(err)) return err
    const classified = classifyBinanceError(err)
    if (classified.kind === 'fatal') return fatalOrSame(err, symbol, this.onNote)
    const key = `${symbol}:${what}`
    if (!this.noted.has(key)) {
      this.noted.add(key)
      this.onNote({ kind: 'rejected', symbol, phrase: classified.message, data: { code: classified.code, order: what } })
    }
    if (what !== 'open' && what !== 'leverage') return err
    if (classified.code === -2019) return new OrderRejectedError('insufficient_margin', classified.message, classified.message)
    if (classified.code === -4164) return new OrderRejectedError('min_notional', classified.message, classified.message)
    return new OrderRejectedError('exchange_rejected', classified.message, classified.message)
  }

  // Una posición que Binance dejó de mostrar no recibe órdenes: lo que hay ahí puede no ser del bot.
  private assertPresent(symbol: string): void {
    if (this.vanished.isGone(symbol)) throw new Error(`Binance ya no tiene la posición del bot en ${symbol}: no le mando órdenes hasta encontrar cómo se cerró`)
    if (this.vanished.isDoubtful(symbol)) throw new Error(`Binance no muestra la posición del bot en ${symbol}: no le mando órdenes hasta saber si se cerró`)
  }

  private blocked(symbol: string): boolean {
    return this.vanished.isGone(symbol) || this.vanished.isDoubtful(symbol)
  }

  // Confirmada: sus algos se cancelan y se recuerda con qué estaba protegida.
  private vanish(symbol: string): void {
    const takeProfit = this.account.botAlgos(symbol).find((a) => a.type === 'TAKE_PROFIT_MARKET')?.triggerPrice ?? this.protector.lastTakeProfit(symbol)
    const protection: VanishedProtection = { algoIds: this.protector.idsOf(symbol), stop: this.protector.lastStop(symbol), takeProfit }
    this.vanished.confirm(symbol, protection)
    this.protector.retire(symbol)
    void this.protector.sweep()
  }

  // Volvió: stop y take profit otra vez a sus precios, por lo que le queda al bot. Si Binance
  // no toma el stop, se cierra como cualquier posición sin stop.
  private async reprotect(symbol: string, protection: VanishedProtection): Promise<void> {
    const position = this.book.require(symbol)
    const side = closingSide(position.side)
    const qty = this.openQty(symbol)
    if (protection.stop !== null) {
      const result = await this.protector.ensureStop({ symbol, side, qty, triggerPrice: protection.stop.price })
      if (result.kind === 'failed') {
        if (!(await this.stopFailed(position, protection.stop.price, result.error, 'uncovered'))) throw result.error
        return
      }
    }
    if (protection.takeProfit === null) return
    try {
      await this.protector.place('take_profit', { symbol, side, qty, triggerPrice: protection.takeProfit })
    } catch (err) {
      this.logger.warn({ symbol, err: messageOf(err) }, 'BinanceFuturesExchange: no pude reponer el take profit de una posición que volvió a aparecer')
    }
  }

  private cleared(symbol: string, what: string): void {
    this.noted.delete(`${symbol}:${what}`)
  }

  private infoOf(symbol: string): SymbolInfo {
    const info = this.infos[symbol]
    if (!info) throw new Error(`símbolo desconocido: ${symbol}`)
    return info
  }
}

function doubtRejection(symbol: string, outcome: 'pending' | 'closed'): OrderRejectedError {
  const coin = coinOf(symbol)
  const detail = outcome === 'closed' ? `acabo de cerrar en ${coin} una apertura que había quedado en duda` : `todavía no sé si entró la apertura anterior en ${coin}`
  return new OrderRejectedError('exchange_rejected', `${symbol}: ${detail}`, detail)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
