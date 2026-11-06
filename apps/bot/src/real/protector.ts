// Los stops y take profits del bot en Binance: siempre algorítmicos, `reduceOnly` por la
// cantidad del bot y disparados por la marca (lo fija `BinanceTradeRest.algoOrder`).
//
// - Poner: si ya hay uno del bot igual (mismo tipo, precio en la grilla y cantidad) se usa
//   ése, así reiniciar no duplica; uno que sólo recuerda este proceso (el stream no lo
//   muestra) se confirma por REST antes, porque pudieron cancelarlo a mano. Si no, se pone
//   uno nuevo con reintentos y recién con el nuevo puesto se cancelan los del mismo tipo que
//   quedaron (el stop viejo de un trailing, uno de antes de un reinicio): la posición nunca
//   queda sin stop.
// - Achicar: después de un cierre a medias, la cantidad pasa a lo que le queda al bot, igual
//   que al mover (el nuevo antes del viejo). Si Toti sumó a mano, uno por la cantidad entera
//   cerraría parte de lo suyo. Si Binance no toma el nuevo, `ensureStop` y `ensureTakeProfit`
//   (en cada vuelta de la reconciliación) lo vuelven a intentar.
// - Cancelar: lo que Binance no cancela se reintenta con espera creciente (`CancelBackoff`).
// Poner y verificar un stop van de a uno por moneda: la reconciliación nunca ve "sin stop"
// mientras el motor está poniendo uno.

import type { SymbolInfo } from '@sereno/core'
import type { OrderSide } from '@sereno/core/src/exchange/types'
import type { Logger } from 'pino'
import { formatPrice, formatQty } from '../binance/precision'
import { classifyBinanceError } from '../binance/trade-errors'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { AlgoKind, AlgoOrder } from '../binance/trade-types'
import type { Clock } from '../live/timers'
import type { RealAccount } from './account'
import { CancelBackoff } from './cancel-backoff'
import { parseClientId, type ClientIds } from './client-id'
import { fatalOrSame, type NoteSink } from './notes'
import { withRetries } from './retry'

export type ProtectorTradeApi = Pick<BinanceTradeRest, 'algoOrder' | 'cancelAlgo' | 'openAlgoOrders'>
export type ProtectiveKind = 'stop' | 'take_profit'

export interface ProtectiveRequest {
  symbol: string
  side: OrderSide
  qty: number
  triggerPrice: number
}

export interface PlacedAlgo {
  symbol: string
  kind: ProtectiveKind
  triggerPrice: number
  qty: number
}

export interface ProtectorDeps {
  trade: ProtectorTradeApi
  account: Pick<RealAccount, 'botAlgos'>
  ids: ClientIds
  // El contrato vigente (cambia si el motor se rehace con otros contratos).
  infoOf: (symbol: string) => SymbolInfo
  clock: Clock
  delaysMs: readonly number[]
  onNote: NoteSink
  logger: Logger
}

// `failed`: Binance no tiene ninguno y no tomó el nuevo (el error, ya avisado si es fatal).
// `oversized`: tiene uno por otra cantidad y no tomó el de la cantidad del bot; el viejo sigue
// cubriendo (por más) y la próxima revisión lo vuelve a intentar.
// `trimmed`: junto al de la cantidad del bot quedaba otro por otra cantidad; se canceló.
export type EnsuredStop =
  | { kind: 'live' }
  | { kind: 'placed'; clientAlgoId: string }
  | { kind: 'resized'; clientAlgoId: string }
  | { kind: 'trimmed' }
  | { kind: 'oversized'; error: unknown }
  | { kind: 'failed'; error: unknown }

// Un stop o take profit del bot que todavía puede disparar.
export interface LiveTrigger {
  clientAlgoId: string
  kind: ProtectiveKind
  triggerPrice: number
}

// Lo mismo para el take profit, que no protege: sin ninguno no se pone otro.
export type EnsuredTakeProfit = { kind: 'live' } | { kind: 'resized' } | { kind: 'oversized'; error: unknown }

interface LiveAlgo {
  clientAlgoId: string
  triggerPrice: number
  qty: number
  // Lo muestra la cuenta (el stream o el último sync), no sólo la memoria de este proceso.
  seen: boolean
}

const ALGO_TYPE: Record<ProtectiveKind, AlgoKind> = { stop: 'STOP_MARKET', take_profit: 'TAKE_PROFIT_MARKET' }

export class Protector {
  // Lo que este proceso puso o adoptó al reutilizar, por `clientAlgoId`.
  private readonly placed = new Map<string, PlacedAlgo>()
  // Lo que este proceso ya canceló: el motor pide cancelar el stop viejo después de que
  // `place` lo canceló al poner el nuevo, y ahí no hace falta otro pedido.
  private readonly cancelled = new Map<string, string>()
  private readonly lastStops = new Map<string, { price: number; qty: number }>()
  private readonly backoff: CancelBackoff
  private readonly locks = new Map<string, Promise<unknown>>()
  private sweeping: Promise<void> | null = null

  constructor(private readonly deps: ProtectorDeps) {
    this.backoff = new CancelBackoff(deps.clock.now)
  }

  place(kind: ProtectiveKind, req: ProtectiveRequest): Promise<string> {
    return this.locked(req.symbol, () => this.placeUnlocked(kind, req))
  }

  // Que Binance tenga un stop del bot en la moneda por `req.qty` (consulta REST, que manda
  // sobre el stream): si no tiene ninguno lo pone, y si tiene uno por otra cantidad (no se
  // pudo achicar después de un cierre a medias) pone el de la cantidad del bot y después
  // cancela el viejo. Uno por otra cantidad que sobra junto al bueno se cancela: disparado,
  // podría cerrar lo de Toti. Si la consulta falla, tira: no se sabe y no se toca nada.
  ensureStop(req: ProtectiveRequest): Promise<EnsuredStop> {
    return this.locked(req.symbol, async (): Promise<EnsuredStop> => {
      const stops = (await this.openOfBot(req.symbol)).filter((a) => a.type === 'STOP_MARKET')
      const sized = await this.sizeLive('stop', req, stops)
      if (sized !== null) return sized
      if (stops.length > 0) {
        try {
          return { kind: 'resized', clientAlgoId: await this.placeUnlocked('stop', req, stops.map(knownOf)) }
        } catch (error) {
          return { kind: 'oversized', error }
        }
      }
      // Binance no tiene ninguno: lo que este proceso recuerda (o el stream todavía muestra)
      // ya no está y no sirve para reutilizar.
      for (const [id, p] of this.placed) if (p.symbol === req.symbol && p.kind === 'stop') this.placed.delete(id)
      try {
        return { kind: 'placed', clientAlgoId: await this.placeUnlocked('stop', req, []) }
      } catch (error) {
        return { kind: 'failed', error }
      }
    })
  }

  // Que los take profits del bot en la moneda sean por `req.qty`, como `ensureStop`: uno por otra
  // cantidad se cambia por uno de la cantidad del bot al mismo precio (el nuevo antes que el
  // viejo) y uno que sobra junto al bueno se cancela. Sin ninguno no pone nada.
  ensureTakeProfit(req: Omit<ProtectiveRequest, 'triggerPrice'>): Promise<EnsuredTakeProfit> {
    return this.locked(req.symbol, async (): Promise<EnsuredTakeProfit> => {
      const tps = (await this.openOfBot(req.symbol)).filter((a) => a.type === 'TAKE_PROFIT_MARKET')
      const current = tps.at(-1)
      if (!current) return { kind: 'live' }
      const sized = await this.sizeLive('take_profit', { ...req, triggerPrice: current.triggerPrice }, tps)
      if (sized !== null) return sized.kind === 'trimmed' ? { kind: 'resized' } : sized
      try {
        await this.placeUnlocked('take_profit', { ...req, triggerPrice: current.triggerPrice }, tps.map(knownOf))
        return { kind: 'resized' }
      } catch (error) {
        return { kind: 'oversized', error }
      }
    })
  }

  // ¿Binance tiene algún stop del bot en la moneda? Por REST, que manda sobre el stream.
  async hasLiveStop(symbol: string): Promise<boolean> {
    return (await this.openOfBot(symbol)).some((a) => a.type === 'STOP_MARKET')
  }

  // Para el motor: cancelar una orden suya. Inexistente = cancelada. Una que falló hace poco
  // espera su turno sin molestar a Binance.
  async cancel(symbol: string, clientAlgoId: string): Promise<void> {
    if (this.cancelled.has(clientAlgoId)) return
    const waitMs = this.backoff.waitFor(clientAlgoId)
    if (waitMs > 0) throw new Error(`Binance no canceló ${clientAlgoId} en ${symbol}: reintento en ${Math.ceil(waitMs / 1_000)} s`)
    try {
      await this.cancelNow(symbol, clientAlgoId)
    } catch (err) {
      throw fatalOrSame(err, symbol, this.deps.onNote)
    }
  }

  // Stop y take profit vivos del bot en la moneda, a `qty` y al mismo precio. No tira: si
  // Binance no toma uno, queda el anterior (sigue cubriendo, aunque por más).
  async resize(symbol: string, side: OrderSide, qty: number): Promise<void> {
    const { stepSize } = this.deps.infoOf(symbol)
    for (const kind of ['stop', 'take_profit'] as const) {
      const live = this.liveOfType(symbol, ALGO_TYPE[kind])
      const current = live.at(-1)
      if (!current || live.every((a) => near(a.qty, qty, stepSize))) continue
      try {
        await this.place(kind, { symbol, side, qty, triggerPrice: current.triggerPrice })
      } catch (err) {
        this.deps.logger.warn({ symbol, kind, qty, err: err instanceof Error ? err.message : String(err) }, 'Protector: no pude achicar el algo después de un cierre a medias; queda el anterior')
      }
    }
  }

  // La posición de `symbol` ya no es del bot: sus algos se cancelan (ahora o con espera).
  retire(symbol: string): void {
    for (const id of this.idsOf(symbol)) this.backoff.add(id, symbol)
    for (const [id, p] of this.placed) if (p.symbol === symbol) this.placed.delete(id)
    for (const [id, s] of this.cancelled) if (s === symbol) this.cancelled.delete(id)
    this.lastStops.delete(symbol)
  }

  // Cancela lo que tiene el turno vencido. No tira: lo que falla vuelve a esperar.
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepDue().finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  // Todo algo del bot, ya. Tira al final si alguno no se pudo (queda para reintentar).
  async cancelAll(): Promise<void> {
    const ids = new Map<string, string>()
    for (const a of this.deps.account.botAlgos()) ids.set(a.clientAlgoId, a.symbol)
    for (const [id, p] of this.placed) ids.set(id, p.symbol)
    for (const { clientAlgoId, symbol } of this.backoff.all()) ids.set(clientAlgoId, symbol)
    let failed = 0
    for (const [id, symbol] of ids) {
      if (this.cancelled.has(id)) continue
      try {
        await this.cancelNow(symbol, id)
      } catch (err) {
        if (classifyBinanceError(err).kind === 'fatal') throw fatalOrSame(err, symbol, this.deps.onNote)
        failed++
      }
    }
    if (failed > 0) throw new Error(`no pude cancelar ${failed} órdenes del bot en Binance; las reintento`)
  }

  lastStop(symbol: string): { price: number; qty: number } | null {
    const stop = this.lastStops.get(symbol)
    return stop ? { ...stop } : null
  }

  // El precio del último take profit que este proceso puso (o reutilizó) en la moneda.
  lastTakeProfit(symbol: string): number | null {
    let price: number | null = null
    for (const p of this.placed.values()) if (p.symbol === symbol && p.kind === 'take_profit') price = p.triggerPrice
    return price
  }

  info(clientAlgoId: string): PlacedAlgo | undefined {
    const p = this.placed.get(clientAlgoId)
    return p && { ...p }
  }

  // Los stops y take profits vivos del bot en la moneda: los que muestra la cuenta y los que
  // puso este proceso (el stream puede no haber avisado todavía el alta ni el disparo).
  liveTriggers(symbol: string): LiveTrigger[] {
    return (['stop', 'take_profit'] as const).flatMap((kind) => this.liveOfType(symbol, ALGO_TYPE[kind]).map((a) => ({ clientAlgoId: a.clientAlgoId, kind, triggerPrice: a.triggerPrice })))
  }

  // Los algos del bot en la moneda que este proceso conoce (puestos o vistos en Binance).
  idsOf(symbol: string): string[] {
    const ids = new Set(this.deps.account.botAlgos(symbol).map((a) => a.clientAlgoId))
    for (const [id, p] of this.placed) if (p.symbol === symbol) ids.add(id)
    return [...ids]
  }

  // ---------- Internos ----------

  // Si alguno de `live` ya es por `req.qty`, los demás sobran y se cancelan: `trimmed` si se
  // canceló alguno (lo que Binance no cancela vuelve en la próxima revisión), si no `live`.
  // null si ninguno es por esa cantidad.
  private async sizeLive(kind: ProtectiveKind, req: ProtectiveRequest, live: readonly AlgoOrder[]): Promise<{ kind: 'live' } | { kind: 'trimmed' } | null> {
    const { stepSize } = this.deps.infoOf(req.symbol)
    const fits = (a: AlgoOrder) => near(a.quantity, req.qty, stepSize)
    if (!live.some(fits)) return null
    const cancelled: string[] = []
    for (const a of live) if (!fits(a) && (await this.cancelQuietly(req.symbol, a.clientAlgoId))) cancelled.push(a.clientAlgoId)
    if (cancelled.length === 0) return { kind: 'live' }
    this.deps.logger.info({ symbol: req.symbol, kind, cancelled }, 'Protector: sobraban algos del bot por otra cantidad')
    return { kind: 'trimmed' }
  }

  private async placeUnlocked(kind: ProtectiveKind, req: ProtectiveRequest, known?: LiveAlgo[]): Promise<string> {
    const { symbol } = req
    const info = this.deps.infoOf(symbol)
    const type = ALGO_TYPE[kind]
    const triggerPrice = formatPrice(req.triggerPrice, info.tickSize)
    const quantity = formatQty(req.qty, info.stepSize)
    if (!(Number(quantity) > 0)) throw new RangeError(`cantidad inválida para el ${kind} de ${symbol}: ${req.qty}`)
    const placed: PlacedAlgo = { symbol, kind, triggerPrice: Number(triggerPrice), qty: Number(quantity) }
    const sameType = known ?? this.liveOfType(symbol, type)
    const equal = await this.reusable(symbol, sameType, placed, info)
    let clientAlgoId: string
    if (equal) {
      clientAlgoId = equal.clientAlgoId
    } else {
      clientAlgoId = this.deps.ids.next(kind === 'stop' ? 's' : 't')
      const send = () => this.deps.trade.algoOrder({ symbol, side: req.side === 'buy' ? 'BUY' : 'SELL', type, triggerPrice, quantity, clientAlgoId })
      try {
        await withRetries(this.deps.clock, this.deps.delaysMs, send)
      } catch (err) {
        throw fatalOrSame(err, symbol, this.deps.onNote)
      }
    }
    this.placed.set(clientAlgoId, placed)
    if (kind === 'stop') this.lastStops.set(symbol, { price: placed.triggerPrice, qty: placed.qty })
    // Con el nuevo puesto, los demás del mismo tipo sobran.
    for (const stale of sameType) if (stale.clientAlgoId !== clientAlgoId) await this.cancelQuietly(symbol, stale.clientAlgoId)
    return clientAlgoId
  }

  // Uno igual al pedido que sigue vivo. Si sólo lo recuerda este proceso, REST lo confirma:
  // si ya no está (lo cancelaron a mano), se olvida y hay que poner otro.
  private async reusable(symbol: string, sameType: LiveAlgo[], wanted: PlacedAlgo, info: SymbolInfo): Promise<LiveAlgo | undefined> {
    const equal = sameType.find((a) => near(a.triggerPrice, wanted.triggerPrice, info.tickSize) && near(a.qty, wanted.qty, info.stepSize))
    if (!equal || equal.seen) return equal
    if ((await this.openOfBot(symbol)).some((a) => a.clientAlgoId === equal.clientAlgoId)) return equal
    this.placed.delete(equal.clientAlgoId)
    return undefined
  }

  // Los del mismo tipo que siguen vivos: los que ve la cuenta y los que puso este proceso
  // (el stream puede no haber avisado todavía el alta).
  private liveOfType(symbol: string, type: AlgoKind): LiveAlgo[] {
    const live = new Map<string, LiveAlgo>()
    for (const a of this.deps.account.botAlgos(symbol)) {
      if (a.type === type && !this.cancelled.has(a.clientAlgoId)) live.set(a.clientAlgoId, { clientAlgoId: a.clientAlgoId, triggerPrice: a.triggerPrice, qty: a.quantity, seen: true })
    }
    for (const [id, p] of this.placed) {
      if (p.symbol === symbol && ALGO_TYPE[p.kind] === type && !this.cancelled.has(id) && !live.has(id)) live.set(id, { clientAlgoId: id, triggerPrice: p.triggerPrice, qty: p.qty, seen: false })
    }
    return [...live.values()]
  }

  private async openOfBot(symbol: string): Promise<AlgoOrder[]> {
    let open
    try {
      open = await this.deps.trade.openAlgoOrders(symbol)
    } catch (err) {
      throw fatalOrSame(err, symbol, this.deps.onNote)
    }
    return open.filter((a) => parseClientId(a.clientAlgoId)?.short === this.deps.ids.short)
  }

  // El error sale crudo: quien llama decide si avisa y cómo.
  private async cancelNow(symbol: string, clientAlgoId: string): Promise<void> {
    try {
      await this.deps.trade.cancelAlgo(clientAlgoId)
    } catch (err) {
      this.backoff.failed(clientAlgoId, symbol)
      throw err
    }
    this.backoff.done(clientAlgoId)
    this.cancelled.set(clientAlgoId, symbol)
  }

  // No tira: un fatal se avisa (el que escucha apaga la sesión) y lo demás vuelve a esperar.
  // true si se canceló ahora.
  private async cancelQuietly(symbol: string, clientAlgoId: string): Promise<boolean> {
    if (this.backoff.waitFor(clientAlgoId) > 0) return false
    try {
      await this.cancelNow(symbol, clientAlgoId)
      return true
    } catch (err) {
      const reported = fatalOrSame(err, symbol, this.deps.onNote)
      this.deps.logger.warn({ symbol, clientAlgoId, err: reported instanceof Error ? reported.message : String(reported) }, 'Protector: Binance no canceló un algo del bot; se reintenta con espera')
      return false
    }
  }

  private async sweepDue(): Promise<void> {
    for (const { clientAlgoId, symbol } of this.backoff.due()) await this.cancelQuietly(symbol, clientAlgoId)
  }

  private locked<T>(symbol: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(symbol) ?? Promise.resolve()).then(task)
    const tail = run.catch(() => undefined)
    this.locks.set(symbol, tail)
    void tail.then(() => {
      if (this.locks.get(symbol) === tail) this.locks.delete(symbol)
    })
    return run
  }
}

function knownOf(a: AlgoOrder): LiveAlgo {
  return { clientAlgoId: a.clientAlgoId, triggerPrice: a.triggerPrice, qty: a.quantity, seen: true }
}

function near(a: number, b: number, step: number): boolean {
  return Math.abs(a - b) < step / 2
}
