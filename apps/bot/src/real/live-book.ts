// Lo que la cuenta real sabe de Binance en este momento: posiciones abiertas y algorítmicas
// abiertas de la sesión, del último sync por REST más lo que el stream informó después.
//
// Un sync tarda: si mientras tanto el stream toca una moneda o un algo, para esa clave gana el
// stream. Un evento recibido con el pedido ya en curso es igual de nuevo que la foto de REST
// (si pasó antes de que Binance la armara, la foto ya lo trae) o más nuevo. Si dos syncs se
// enciman, la foto de uno que termina después de otro más nuevo no se aplica.
//
// Al liquidar, Binance primero cancela las órdenes abiertas de la moneda: los algos del bot
// salen del libro antes de que llegue la orden de liquidación. Por eso los que Binance canceló
// o venció se recuerdan un rato (`LIQUIDATION_LINK_MS`) para nombrar la liquidación.

import type { AccountUpdate, AlgoOrder, AlgoUpdate, BinancePosition } from '../binance/trade-types'

// El stream no informa apalancamiento ni precio de liquidación: el apalancamiento es el último
// visto por REST en esa moneda (null si nunca se vio) y la liquidación, la del último sync
// mientras la cantidad no cambie (después, null hasta el próximo).
export interface LivePosition extends Omit<BinancePosition, 'leverage'> {
  leverage: number | null
}

export interface SyncMark {
  seq: number
  symbols: Set<string>
  algos: Set<string>
}

interface RetiredAlgo {
  algo: AlgoOrder
  // Reloj local al recibir la baja.
  at: number
}

// Un algo que todavía protege: abierto o disparándose.
const OPEN_ALGO_STATUSES: ReadonlySet<string> = new Set(['NEW', 'TRIGGERING'])
// Un algo que se fue sin disparar: lo canceló alguien o Binance lo venció (al liquidar, entre otros).
const UNTRIGGERED_EXIT_STATUSES: ReadonlySet<string> = new Set(['CANCELED', 'EXPIRED'])
// Binance cancela y liquida en el mismo paso: un minuto cubre de sobra lo que tarden los
// eventos entre uno y otro, y no deja que un stop de una posición ya cerrada reclame la
// liquidación de una que Toti abrió después en la misma moneda.
const LIQUIDATION_LINK_MS = 60_000
// Las bajas que Binance hace al liquidar llegan juntas (milisegundos entre una y otra).
const RETIRE_BURST_MS = 1_000

export class LiveBook {
  private positions = new Map<string, LivePosition>()
  private algos = new Map<string, AlgoOrder>()
  private readonly retired = new Map<string, RetiredAlgo>()
  private readonly leverages = new Map<string, number>()
  private readonly syncs = new Set<SyncMark>()
  private syncSeq = 0
  private appliedSeq = 0

  constructor(private readonly now: () => number) {}

  position(symbol: string): LivePosition | null {
    const p = this.positions.get(symbol)
    return p ? { ...p } : null
  }

  algosOf(symbol?: string): AlgoOrder[] {
    return [...this.algos.values()].filter((a) => symbol === undefined || a.symbol === symbol).map((a) => ({ ...a }))
  }

  // El algo que nombra una liquidación: el stop del bot en la moneda, si no cualquiera suyo;
  // primero los abiertos, después los que Binance acaba de dar de baja sin disparar, del más
  // reciente al más viejo (un stop de una posición anterior, dado de baja antes, no la
  // reclama). Entre los que Binance dio de baja en la misma tanda, el stop.
  protectiveAlgo(symbol: string): AlgoOrder | undefined {
    const open = this.algosOf(symbol)
    if (open.length > 0) return open.find((a) => a.type === 'STOP_MARKET') ?? open[0]
    const cutoff = this.now() - LIQUIDATION_LINK_MS
    const recent = [...this.retired.values()].filter((r) => r.algo.symbol === symbol && r.at >= cutoff).sort((a, b) => b.at - a.at)
    const newest = recent[0]
    if (!newest) return undefined
    const burst = recent.filter((r) => r.at >= newest.at - RETIRE_BURST_MS)
    const chosen = burst.find((r) => r.algo.type === 'STOP_MARKET') ?? newest
    return { ...chosen.algo }
  }

  applyAccount(u: AccountUpdate): void {
    for (const p of u.positions) {
      for (const mark of this.syncs) mark.symbols.add(p.symbol)
      if (p.amount === 0) {
        this.positions.delete(p.symbol)
        continue
      }
      const prev = this.positions.get(p.symbol)
      this.positions.set(p.symbol, {
        symbol: p.symbol,
        amount: p.amount,
        entryPrice: p.entryPrice,
        markPrice: p.entryPrice + p.unrealizedPnl / p.amount,
        liquidationPrice: prev && prev.amount === p.amount ? prev.liquidationPrice : null,
        marginType: p.marginType,
        // Como en `positionRisk`: la billetera de la posición más su no realizado.
        isolatedMargin: p.marginType === 'isolated' ? p.isolatedMargin + p.unrealizedPnl : 0,
        leverage: this.leverages.get(p.symbol) ?? null,
      })
    }
  }

  applyAlgo(u: AlgoUpdate): void {
    for (const mark of this.syncs) mark.algos.add(u.clientAlgoId)
    const algo: AlgoOrder = {
      symbol: u.symbol,
      clientAlgoId: u.clientAlgoId,
      algoId: u.algoId,
      type: u.type,
      side: u.side,
      triggerPrice: u.triggerPrice,
      quantity: u.quantity,
      status: u.status,
      actualOrderId: u.triggeredOrderId,
    }
    if (OPEN_ALGO_STATUSES.has(u.status)) {
      this.algos.set(u.clientAlgoId, algo)
      return
    }
    this.algos.delete(u.clientAlgoId)
    if (UNTRIGGERED_EXIT_STATUSES.has(u.status)) this.retire(algo)
  }

  beginSync(): SyncMark {
    const mark: SyncMark = { seq: ++this.syncSeq, symbols: new Set(), algos: new Set() }
    this.syncs.add(mark)
    return mark
  }

  endSync(mark: SyncMark, positions: readonly BinancePosition[], botAlgos: readonly AlgoOrder[]): void {
    this.syncs.delete(mark)
    if (mark.seq < this.appliedSeq) return
    this.appliedSeq = mark.seq
    for (const p of positions) this.leverages.set(p.symbol, p.leverage)
    this.positions = merge<LivePosition>(this.positions, positions, (p) => p.symbol, mark.symbols)
    this.algos = merge(this.algos, botAlgos, (a) => a.clientAlgoId, mark.algos)
  }

  abandonSync(mark: SyncMark): void {
    this.syncs.delete(mark)
  }

  private retire(algo: AlgoOrder): void {
    const at = this.now()
    for (const [id, r] of this.retired) if (r.at < at - LIQUIDATION_LINK_MS) this.retired.delete(id)
    this.retired.set(algo.clientAlgoId, { algo, at })
  }
}

// La foto de REST, salvo en las claves que el stream tocó durante el sync.
function merge<T>(live: ReadonlyMap<string, T>, rest: readonly T[], key: (item: T) => string, touched: ReadonlySet<string>): Map<string, T> {
  const next = new Map<string, T>()
  for (const item of rest) if (!touched.has(key(item))) next.set(key(item), { ...item })
  for (const k of touched) {
    const item = live.get(k)
    if (item !== undefined) next.set(k, item)
  }
  return next
}
