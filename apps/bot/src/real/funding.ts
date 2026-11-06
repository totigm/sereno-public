// El funding que Binance cobró o pagó en las posiciones del bot, leído de `/fapi/v1/income`
// (una fila por cobro, con su `tranId`). Lo pide la reconciliación en cada vuelta y, desde
// `start`, cada ACCOUNT_UPDATE con motivo FUNDING_FEE; cada `tranId` se cuenta una sola vez.
// `start` va después de restaurar el motor: una fila leída antes, sin las posiciones del bot
// en el adaptador, se daría por ajena y no se volvería a contar.
//
// Si Toti tiene cantidad propia en la moneda, Binance cobra sobre el total: al bot le toca la
// parte de su cantidad. Lo que corresponde se encola en el adaptador (`queueFunding`) y llega
// al motor con `applyFunding`; quien escucha `onFunding` (el runtime) le avisa al motor con
// `engine.onFunding` para que no espere al próximo evento de funding del mercado.

import { direction } from '@sereno/core/src/exchange/sides'
import type { ExchangePosition, FundingApplied } from '@sereno/core/src/exchange/types'
import type { Logger } from 'pino'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { AccountUpdate, IncomeRow } from '../binance/trade-types'
import { silentLogger } from '../logger'
import type { RealAccount } from './account'
import type { BinanceFuturesExchange } from './exchange'

export type FundingTradeApi = Pick<BinanceTradeRest, 'fundingIncome'>
export type FundingAccount = Pick<RealAccount, 'position' | 'onAccountUpdate'>
export type FundingExchange = Pick<BinanceFuturesExchange, 'getPositions' | 'queueFunding'>

export interface FundingCollectorOptions {
  trade: FundingTradeApi
  exchange: FundingExchange
  account: FundingAccount
  // Desde cuándo pedir (ms de Binance): el inicio de la sesión o el último funding guardado.
  since: number
  logger?: Logger
}

const QTY_TOLERANCE = 1e-9

export class FundingCollector {
  private readonly trade: FundingTradeApi
  private readonly exchange: FundingExchange
  private readonly account: FundingAccount
  private readonly logger: Logger
  private readonly seen = new Set<number>()
  private readonly listeners = new Set<(applied: FundingApplied[]) => void>()
  private cursor: number
  private running: Promise<FundingApplied[]> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(opts: FundingCollectorOptions) {
    this.trade = opts.trade
    this.exchange = opts.exchange
    this.account = opts.account
    this.logger = opts.logger ?? silentLogger
    this.cursor = opts.since
  }

  // Desde ahora cada ACCOUNT_UPDATE de funding dispara una lectura.
  start(): void {
    this.unsubscribe ??= this.account.onAccountUpdate((u) => this.onAccountUpdate(u))
  }

  // Lo nuevo desde la última vez, ya encolado en el adaptador. De a uno: dos pedidos a la
  // vez (la reconciliación y un ACCOUNT_UPDATE) esperan al mismo.
  collect(): Promise<FundingApplied[]> {
    this.running ??= this.collectOnce().finally(() => {
      this.running = null
    })
    return this.running
  }

  onFunding(cb: (applied: FundingApplied[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async collectOnce(): Promise<FundingApplied[]> {
    const rows = await this.trade.fundingIncome(this.cursor)
    const fresh = rows.filter((r) => !this.seen.has(r.tranId)).sort((a, b) => a.time - b.time || a.tranId - b.tranId)
    if (fresh.length === 0) return []
    const positions = new Map((await this.exchange.getPositions()).map((p) => [p.symbol, p]))
    const applied: FundingApplied[] = []
    for (const row of fresh) {
      this.seen.add(row.tranId)
      // Las filas del mismo instante pueden llegar en otra página: se vuelve a pedir desde ahí.
      this.cursor = Math.max(this.cursor, row.time)
      const share = this.shareOf(row, positions.get(row.symbol))
      if (share !== null) applied.push(share)
    }
    for (const f of applied) this.exchange.queueFunding(f)
    if (applied.length > 0) this.emit(applied)
    return applied
  }

  // La parte del bot de un cobro; null si en ese momento la moneda no tenía posición del bot.
  private shareOf(row: IncomeRow, position: ExchangePosition | undefined): FundingApplied | null {
    if (!position || row.time < position.openedAt) return null
    const live = this.account.position(row.symbol)
    const binanceQty = live ? Math.abs(live.amount) : position.qty
    const fraction = binanceQty > position.qty + QTY_TOLERANCE ? position.qty / binanceQty : 1
    const amount = row.income * fraction
    const markPrice = live?.markPrice ?? position.markPrice
    // Binance no informa la tasa: sale del monto (el largo paga con tasa positiva).
    const rate = -amount / (direction(position.side) * position.qty * markPrice)
    return { symbol: row.symbol, side: position.side, qty: position.qty, rate, markPrice, amount, at: row.time }
  }

  private onAccountUpdate(u: AccountUpdate): void {
    if (u.reason !== 'FUNDING_FEE') return
    this.collect().catch((err: unknown) => {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'FundingCollector: no pude leer el funding de Binance; lo reintenta la reconciliación')
    })
  }

  private emit(applied: FundingApplied[]): void {
    for (const cb of this.listeners) {
      try {
        cb(applied)
      } catch (err) {
        this.logger.error({ err }, 'FundingCollector: falló quien escucha el funding')
      }
    }
  }
}
