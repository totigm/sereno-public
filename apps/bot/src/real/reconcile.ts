// Binance y la sesión real tienen que decir lo mismo. Dos momentos:
//
// - Al arrancar (`reconcileAtStart`, antes de armar el motor): lo que la base tiene abierto y
//   Binance ya cerró (un stop con el bot apagado) se cierra con los trades reales, aunque
//   Toti haya abierto después del mismo lado; lo que Binance tiene y la base no conoce se
//   adopta sólo si un fill `o` de la sesión lo explica (el bot se cayó entre la orden y el
//   guardado). Lo demás es de Toti y no se toca.
// - Mientras corre (`Reconciler`, cada minuto; cada 10 s sin stream): posiciones del bot que
//   desaparecieron sin evento, stops que faltan, algos del bot sin posición, aperturas que
//   quedaron en duda y el funding.
//
// Qué posición es del bot lo decide la base (a través del motor y el adaptador), nunca
// Binance.

import type { Position, SymbolInfo } from '@sereno/core'
import { direction } from '@sereno/core/src/exchange/sides'
import type { ExchangePosition } from '@sereno/core/src/exchange/types'
import { liquidationPrice } from '@sereno/core/src/risk/liquidation'
import type { PositionRecord, Repos } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { Logger } from 'pino'
import { formatPrice } from '../binance/precision'
import { classifyBinanceError } from '../binance/trade-errors'
import type { BinancePosition, UserTrade } from '../binance/trade-types'
import { liveIdPrefix } from '../live/engine-build'
import type { Clock, TimerHandle } from '../live/timers'
import { silentLogger } from '../logger'
import type { RealAccount, SyncSnapshot } from './account'
import { adoptionFill, placeAdoptedStop, type AdoptedStopDeps } from './adoption'
import { sessionShort } from './client-id'
import { closedUnderneath, closingByRest, tradesSince, type ClosingQuery, type LookupTradeApi } from './closing-fill'
import type { BinanceFuturesExchange } from './exchange'
import type { FundingCollector } from './funding'
import { coinOf, foreignPhrase, isBinanceFailure, reconciledPhrase, type NoteSink, type RealNote } from './notes'
import type { OrderFill } from './order-tracker'
import type { PendingClose } from './pending-close'

export const ADOPTED_REASON = 'La adopté de Binance: me caí entre la orden y el guardado.'

// Sin ATR de 1h (sin velas al arrancar) el stop de una adoptada va a esta fracción de la entrada.
const FALLBACK_STOP_FRACTION = 0.02
// Margen sobre el reloj local para el fin de la búsqueda de trades (relojes desfasados).
const CLOCK_SKEW_MS = 60_000

// ---------- Al arrancar ----------

export interface StartReconcileDeps {
  repos: Pick<Repos, 'positions'>
  account: Pick<RealAccount, 'sync'>
  trade: LookupTradeApi
  // Para el stop de una adoptada.
  stops: AdoptedStopDeps
  sessionId: string
  infos: Record<string, SymbolInfo>
  atr1h: (symbol: string) => Promise<number | null>
  settings: Settings
  now: number
}

// Va entero al adaptador (`atStart`) antes de restaurar el motor.
export interface StartReconcile {
  // Las abiertas de la base que Binance ya cerró: el primer tick las cierra.
  pendingCloses: Map<string, PendingClose>
  adopted: string[]
  foreign: string[]
  // Abiertas de la base que Binance ya no tiene y cuyo cierre todavía no aparece.
  vanished: string[]
  notes: RealNote[]
}

export async function reconcileAtStart(deps: StartReconcileDeps): Promise<StartReconcile> {
  const { repos, account, sessionId, now } = deps
  const result: StartReconcile = { pendingCloses: new Map(), adopted: [], foreign: [], vanished: [], notes: [] }
  const snapshot = await account.sync()
  const open = await repos.positions.listOpen(sessionId)
  const known = new Set(open.map((p) => p.symbol))
  let adoptedAny = false

  for (const record of open) {
    const live = snapshot.positions.get(record.symbol)
    const query = closingQueryOf(deps, record, now)
    if (live && sameSide(live.amount, record.side)) {
      // Lo de Binance puede ser de Toti, abierto después de que se cerró la del bot.
      const close = await closedUnderneath(deps.trade, query, live.amount)
      if (!close) continue
      result.pendingCloses.set(record.symbol, close)
      result.notes.push(reconciledNote(record, close))
      result.foreign.push(record.symbol)
      result.notes.push({ kind: 'foreign_position', symbol: record.symbol, phrase: foreignPhrase(record.symbol), data: { amount: live.amount } })
      continue
    }
    const close = await closingByRest(deps.trade, query)
    if (close) {
      result.pendingCloses.set(record.symbol, close)
      result.notes.push(reconciledNote(record, close))
    } else {
      result.vanished.push(record.symbol)
      result.notes.push({
        kind: 'mismatch',
        symbol: record.symbol,
        phrase: `Binance no muestra mi posición en ${coinOf(record.symbol)} y todavía no encontré el cierre: la sigo buscando.`,
        data: { positionId: record.id },
      })
    }
  }

  for (const [symbol, live] of snapshot.positions) {
    if (known.has(symbol)) continue
    const adopted = deps.infos[symbol] ? await adoptionFill(deps.trade, symbol, live.amount, sessionShort(sessionId), now) : null
    if (adopted === null) {
      result.foreign.push(symbol)
      result.notes.push({ kind: 'foreign_position', symbol, phrase: foreignPhrase(symbol), data: { amount: live.amount } })
      continue
    }
    const position = adoptedPosition(deps, live, adopted, await deps.atr1h(symbol))
    if (await repos.positions.insertAdopted(sessionId, position)) {
      result.adopted.push(symbol)
      const phrase = `Adopté ${position.qty} ${coinOf(symbol)} de Binance: me caí entre la orden y el guardado. Le pongo stop en ${position.stopPrice}.`
      result.notes.push({ kind: 'adopted', symbol, phrase, data: { positionId: position.id, qty: position.qty, entryPrice: position.entryPrice, stopPrice: position.stopPrice } })
      const rejected = await protectAdopted(deps, position)
      if (rejected) result.notes.push(rejected)
      adoptedAny = true
    }
  }
  // Que la cuenta vea los stops de las adoptadas: el motor los reutiliza en vez de duplicarlos.
  if (adoptedAny) await account.sync()
  return result
}

// El stop de la adoptada ya. Si Binance no lo toma, la nota del rechazo (un fatal sale como
// error: la sesión se apaga).
async function protectAdopted(deps: StartReconcileDeps, position: Position): Promise<RealNote | null> {
  try {
    await placeAdoptedStop(deps.stops, position, infoOf(deps.infos, position.symbol))
    return null
  } catch (err) {
    if (!isBinanceFailure(err)) throw err
    const classified = classifyBinanceError(err)
    if (classified.kind === 'fatal') throw new Error(classified.message)
    return { kind: 'rejected', symbol: position.symbol, phrase: classified.message, data: { code: classified.code, order: 'stop' } }
  }
}

function closingQueryOf(deps: StartReconcileDeps, record: PositionRecord, now: number): ClosingQuery {
  return {
    symbol: record.symbol,
    side: record.side,
    qty: record.qty,
    since: record.openedAt,
    until: now + CLOCK_SKEW_MS,
    clientAlgoIds: [record.stopOrderId, record.tpOrderId].filter((id): id is string => id !== null),
    liquidationPrice: record.liquidationPrice,
    stepSize: infoOf(deps.infos, record.symbol).stepSize,
  }
}

function reconciledNote(record: PositionRecord, close: PendingClose): RealNote {
  return { kind: 'reconciled', symbol: record.symbol, phrase: reconciledPhrase(record.symbol, closedWhat(close)), data: { reason: close.reason, positionId: record.id } }
}

function adoptedPosition(deps: StartReconcileDeps, live: BinancePosition, fill: OrderFill, atr: number | null): Position {
  const { settings, sessionId } = deps
  const info = infoOf(deps.infos, live.symbol)
  const side = live.amount > 0 ? 'long' : 'short'
  const dir = direction(side)
  const entry = fill.avgPrice
  const distance = atr !== null && atr > 0 ? settings.exits.k * atr : entry * FALLBACK_STOP_FRACTION
  const stopPrice = Number(formatPrice(entry - dir * distance, info.tickSize))
  const adverse = Math.abs(entry - stopPrice)
  const takeProfitPrice = Number(formatPrice(entry + dir * settings.exits.tpR * adverse, info.tickSize))
  const notional = fill.qty * entry
  const leverage = live.leverage
  return {
    id: `${liveIdPrefix(sessionId)}-real-${live.symbol}-${fill.at}`,
    symbol: live.symbol,
    side,
    leverage,
    margin: notional / leverage,
    notional,
    qty: fill.qty,
    entryPrice: entry,
    openedAt: fill.at,
    stopPrice,
    takeProfitPrice,
    liquidationPrice: liquidationPrice(side, entry, leverage, info.mmr),
    distanciaStop: adverse / entry,
    riesgoReal: fill.qty * adverse,
    thetaAtOpen: settings.entry.theta,
    trailingActive: false,
    bestPrice: entry,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: fill.commission,
    fundingPaid: 0,
    shadow: false,
    openReason: ADOPTED_REASON,
    signalsAtOpen: [],
    mode: settings.mode,
  }
}

// ---------- Mientras corre ----------

export type ReconcilerExchange = Pick<
  BinanceFuturesExchange,
  | 'getPositions'
  | 'hasPendingClose'
  | 'isClosing'
  | 'queueClose'
  | 'ensureProtected'
  | 'ensureTakeProfit'
  | 'markMismatch'
  | 'noteMissing'
  | 'notePresent'
  | 'isVanished'
  | 'openQty'
  | 'cancelOrder'
  | 'algoIdsOf'
  | 'contract'
  | 'resolveDoubtfulOpens'
>

export interface ReconcilerOptions {
  account: Pick<RealAccount, 'sync' | 'streamUp'>
  exchange: ReconcilerExchange
  trade: LookupTradeApi
  clock: Clock
  onNote: NoteSink
  // Si está, cada vuelta pide también el funding nuevo.
  funding?: Pick<FundingCollector, 'collect'>
  logger?: Logger
}

const INTERVAL_MS = 60_000
const INTERVAL_NO_STREAM_MS = 10_000

export class Reconciler {
  private readonly opts: ReconcilerOptions
  private readonly logger: Logger
  private running: Promise<void> | null = null
  private timer: TimerHandle | null = null
  private started = false

  constructor(opts: ReconcilerOptions) {
    this.opts = opts
    this.logger = opts.logger ?? silentLogger
  }

  // Sin stream los disparos y los cambios de Binance sólo se ven acá: más seguido.
  intervalMs(): number {
    return this.opts.account.streamUp ? INTERVAL_MS : INTERVAL_NO_STREAM_MS
  }

  // Una vuelta ahora y después cada `intervalMs()`, hasta `stop`.
  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(0)
  }

  stop(): void {
    this.started = false
    if (this.timer !== null) this.opts.clock.timers.clearTimeout(this.timer)
    this.timer = null
  }

  // De a una: dos pedidos a la vez esperan la misma vuelta.
  tick(): Promise<void> {
    this.running ??= this.once().finally(() => {
      this.running = null
    })
    return this.running
  }

  private schedule(ms: number): void {
    this.timer = this.opts.clock.timers.setTimeout(() => {
      this.timer = null
      this.tick()
        .catch((err: unknown) => this.logger.error({ err: messageOf(err) }, 'Reconciler: la vuelta falló; reintento en la próxima'))
        .finally(() => {
          if (this.started) this.schedule(this.intervalMs())
        })
    }, ms)
  }

  private async once(): Promise<void> {
    const { account, exchange, funding } = this.opts
    // Una apertura en duda que Binance llenó es del bot y no tiene stop: va primero.
    await exchange.resolveDoubtfulOpens()
    // Sólo las que el bot ya tenía antes de la foto: una abierta durante el sync no está en ella.
    const before = new Set((await exchange.getPositions()).map((p) => p.symbol))
    const snapshot = await account.sync()
    const now = await exchange.getPositions()
    for (const position of now) {
      if (!before.has(position.symbol) || exchange.hasPendingClose(position.symbol) || exchange.isClosing(position.symbol)) continue
      // Lo que falle en una moneda (una consulta, un stop que Binance no toma) no frena a las demás.
      try {
        await this.checkPosition(position, snapshot)
      } catch (err) {
        this.logger.warn({ symbol: position.symbol, err: messageOf(err) }, 'Reconciler: no pude revisar la posición del bot; reintento en la próxima')
      }
    }
    await this.cancelOrphans(snapshot, new Set(now.map((p) => p.symbol)))
    if (funding) {
      try {
        await funding.collect()
      } catch (err) {
        this.logger.warn({ err: messageOf(err) }, 'Reconciler: no pude leer el funding de Binance; reintento en la próxima')
      }
    }
  }

  private async checkPosition(position: ExchangePosition, snapshot: SyncSnapshot): Promise<void> {
    const { exchange } = this.opts
    const { symbol } = position
    const live = snapshot.positions.get(symbol)
    if (!live || !sameSide(live.amount, position.side)) {
      await this.closedOnBinance(position)
      return
    }
    if (exchange.isVanished(symbol)) {
      await this.shownAgain(position, live)
      return
    }
    await exchange.notePresent(symbol, live.amount)
    await this.checkProtection(position, live, snapshot)
  }

  // Una desaparecida que Binance vuelve a mostrar del mismo lado. Con Toti en la moneda lo que
  // se ve nunca es la cantidad del bot sola, así que decide lo mismo que al arrancar: si nada
  // prueba que se cerró (un algo suyo que disparó, la moneda en cero desde la apertura), sigue
  // siendo del bot y recupera su protección. Si se ve menos que lo del bot, algo se cerró: se
  // sigue buscando el cierre, con los mismos trades (mientras dure, es cada vuelta).
  private async shownAgain(position: ExchangePosition, live: BinancePosition): Promise<void> {
    const { exchange, trade } = this.opts
    const { symbol } = position
    const query = this.closingQuery(position)
    const trades = await tradesSince(trade, query)
    const close = await closedUnderneath(trade, query, live.amount, trades)
    if (close) {
      this.settle(symbol, close)
      return
    }
    if ((await exchange.notePresent(symbol, live.amount)) === 'reappeared') {
      this.note(symbol, 'volvió a aparecer; le repuse la protección', { vanished: 'reappeared' })
      this.warnIfMore(symbol, live.amount)
      return
    }
    await this.closedOnBinance(position, query, trades)
  }

  // Con más que lo del bot, lo de más es de Toti; si los trades del cierre llegaron tarde,
  // lo del bot pudo estar cerrado y la protección quedó sobre lo de Toti.
  private warnIfMore(symbol: string, amount: number): void {
    const { exchange } = this.opts
    const botQty = exchange.openQty(symbol)
    if (Math.abs(amount) <= botQty + exchange.contract(symbol).stepSize / 2) return
    this.logger.warn({ symbol, amount, botQty }, 'Reconciler: volvió a aparecer con más que lo del bot; repuse la protección por lo del bot, que si ya se había cerrado queda sobre lo de Toti')
  }

  // La cantidad de Binance contra la del bot, su stop y su take profit: que el stop esté y que
  // los dos sean por lo suyo (uno por más, disparado, cerraría también lo de Toti).
  private async checkProtection(position: ExchangePosition, live: BinancePosition, snapshot: SyncSnapshot): Promise<void> {
    const { exchange } = this.opts
    const { symbol } = position
    const { stepSize } = exchange.contract(symbol)
    // Contra lo que sigue abierto: un cierre a medias del bot no es una diferencia.
    const botQty = exchange.openQty(symbol)
    if (Math.abs(Math.abs(live.amount) - botQty) > stepSize / 2) exchange.markMismatch(symbol, live.amount, botQty)
    const fits = (a: { quantity: number }) => Math.abs(a.quantity - botQty) < stepSize / 2
    const algos = snapshot.botAlgos.filter((a) => a.symbol === symbol)
    const stops = algos.filter((a) => a.type === 'STOP_MARKET')
    if (stops.length === 0 || !stops.every(fits)) {
      const repair = await exchange.ensureProtected(symbol)
      if (repair === 'replaced') this.note(symbol, 'le faltaba el stop en Binance; lo repuse', { stop: 'replaced' })
      if (repair === 'resized') this.note(symbol, `el stop no era por mis ${botQty}; lo ajusté`, { stop: 'resized' })
      if (repair === 'trimmed') this.note(symbol, 'sobraba un stop del bot por otra cantidad; lo cancelé', { stop: 'trimmed' })
      if (repair === 'closed') return
    }
    if (algos.every((a) => a.type !== 'TAKE_PROFIT_MARKET' || fits(a))) return
    if (await exchange.ensureTakeProfit(symbol)) this.note(symbol, `el take profit no era por mis ${botQty}; lo ajusté`, { takeProfit: 'resized' })
  }

  // La posición del bot no está en Binance y no llegó ningún evento: se busca el cierre en los
  // trades. Si todavía no aparece, la primera vuelta la deja en duda (sin órdenes nuevas, con
  // su stop: la foto pudo venir atrasada) y la siguiente la da por desaparecida.
  private async closedOnBinance(position: ExchangePosition, query = this.closingQuery(position), trades?: readonly UserTrade[]): Promise<void> {
    const { exchange, trade } = this.opts
    const { symbol } = position
    const close = await closingByRest(trade, query, trades)
    if (!close) {
      if (exchange.noteMissing(symbol)) this.logger.warn({ symbol }, 'Reconciler: Binance ya no tiene la posición del bot y todavía no encuentro el cierre')
      else this.logger.info({ symbol }, 'Reconciler: Binance no muestra la posición del bot; la vuelvo a mirar en la próxima vuelta')
      return
    }
    this.settle(symbol, close)
  }

  private closingQuery(position: ExchangePosition): ClosingQuery {
    const { exchange, clock } = this.opts
    return {
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      since: position.openedAt,
      until: clock.now() + CLOCK_SKEW_MS,
      clientAlgoIds: exchange.algoIdsOf(position.symbol),
      liquidationPrice: position.liquidationPrice,
      stepSize: exchange.contract(position.symbol).stepSize,
    }
  }

  // El cierre encontrado va al motor con el próximo tick.
  private settle(symbol: string, close: PendingClose): void {
    const { exchange } = this.opts
    // Pudo llegar el evento (o cerrarla el motor) mientras se buscaba.
    if (exchange.hasPendingClose(symbol) || exchange.isClosing(symbol)) return
    exchange.queueClose(symbol, close)
    this.note(symbol, closedWhat(close), { reason: close.reason })
  }

  private async cancelOrphans(snapshot: SyncSnapshot, owned: ReadonlySet<string>): Promise<void> {
    for (const algo of snapshot.botAlgos) {
      if (owned.has(algo.symbol)) continue
      try {
        await this.opts.exchange.cancelOrder(algo.symbol, algo.clientAlgoId)
      } catch (err) {
        this.logger.warn({ symbol: algo.symbol, clientAlgoId: algo.clientAlgoId, err: messageOf(err) }, 'Reconciler: no pude cancelar un algo del bot sin posición; reintento en la próxima')
        continue
      }
      this.note(algo.symbol, `quedaba ${algo.type === 'STOP_MARKET' ? 'un stop' : 'un take profit'} del bot sin posición; lo cancelé`, { clientAlgoId: algo.clientAlgoId })
    }
  }

  private note(symbol: string, what: string, data: Record<string, unknown>): void {
    try {
      this.opts.onNote({ kind: 'reconciled', symbol, phrase: reconciledPhrase(symbol, what), data })
    } catch (err) {
      this.logger.error({ err }, 'Reconciler: falló quien escucha las notas')
    }
  }
}

// ---------- Comunes ----------

function closedWhat(close: PendingClose): string {
  const how: Record<PendingClose['reason'], string> = {
    stop: 'el stop la había cerrado',
    take_profit: 'el take profit la había cerrado',
    liquidation: 'Binance la había liquidado',
    close_all: 'el interruptor la había cerrado',
    unprotected: 'se había cerrado sin stop',
    closed_on_exchange: 'ya estaba cerrada',
  }
  return `${how[close.reason]} y yo la seguía teniendo abierta`
}

function sameSide(amount: number, side: PositionRecord['side']): boolean {
  return amount !== 0 && (amount > 0) === (side === 'long')
}

function infoOf(infos: Record<string, SymbolInfo>, symbol: string): SymbolInfo {
  const info = infos[symbol]
  if (!info) throw new Error(`símbolo desconocido: ${symbol}`)
  return info
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
