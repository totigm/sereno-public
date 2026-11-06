import type { AccountSnapshot, Position } from '@sereno/core'
import { Account, type Marks } from '@sereno/core/src/capital/account'
import { SHOWN_THRESHOLD } from '@sereno/core/src/journal/headline'
import { capitalCard, headline, type CapitalCard } from '@sereno/core/src/journal/phrases'
import { formatTimeBA, sinceLabel, type Settings } from '@sereno/shared'
import type { LedgerView, LivePayload, MarketSnapshotView, PositionValuation } from './live/types'
import type { VerdictView } from './queries/stats'

// Derivaciones puras de lo que llega en vivo: las usan el servidor (al armar el
// payload) y el cliente (cada vez que `/api/live` trae precios nuevos).

/** Sin latido hace más de esto, el bot está "sin conexión" (spec §11.1). */
export const OFFLINE_AFTER_MS = 60_000

export function isOffline(lastHeartbeat: number | null, now: number): boolean {
  return lastHeartbeat === null || now - lastHeartbeat > OFFLINE_AFTER_MS
}

export function marksOf(market: MarketSnapshotView | null): Marks {
  const marks: Marks = {}
  for (const s of market?.symbols ?? []) marks[s.symbol] = s.markPrice
  return marks
}

function markOf(symbol: string, marks: Marks): number | null {
  const mark = marks[symbol]
  return mark !== undefined && Number.isFinite(mark) && mark > 0 ? mark : null
}

export function valuePosition(p: Position, marks: Marks): PositionValuation {
  const mark = markOf(p.symbol, marks)
  if (mark === null) return { mark: null, unrealized: null, net: null, r: null, pctOfMargin: null }
  const unrealized = (mark - p.entryPrice) * p.qty * (p.side === 'long' ? 1 : -1)
  const net = unrealized - p.feesPaid - p.fundingPaid
  return {
    mark,
    unrealized,
    net,
    r: p.riesgoReal > 0 ? net / p.riesgoReal : null,
    pctOfMargin: p.margin > 0 ? net / p.margin : null,
  }
}

export type HeadlineSnapshot = Pick<
  LedgerView,
  'capitalInicial' | 'startedAt' | 'saldo' | 'equityAtDayStart' | 'closedCount' | 'wonCount'
> & {
  lastHeartbeat: number | null
  /** Hora de los precios con que se valúan las abiertas (`market_snapshot.updatedAt`). */
  marksAt: number | null
  /** El veredicto del servidor (`ResumenData.verdict`): cambia sólo al cerrar trades, no con los precios. */
  verdict: HeadlineVerdict | null
}

/** La línea del veredicto debajo del titular (spec §11.1, criterio en §11.6). */
export type HeadlineVerdict = Pick<VerdictView, 'status' | 'reason'>

export interface HeadlineView {
  /** saldo + no realizado bruto de las abiertas con precio. */
  equity: number
  /** equity − I₀: lo que quedaría si se cerrara todo ahora. */
  total: number
  /** Lo cerrado: suma de `pnlNet` de las cerradas, lo mismo que dice Posiciones. */
  realized: number
  /**
   * Lo abierto, neto de las comisiones y el funding que ya pagaron: lo que suman sus
   * filas. `realized + unrealized = total`.
   */
  unrealized: number
  /** Desde las 00:00 de Buenos Aires: realizado del día más la variación de las abiertas. */
  today: number
  /** El total y lo cerrado van para lados distintos. */
  signsDiffer: boolean
  offline: boolean
  /** Sin conexión y con abiertas: la hora de los precios con que están valuadas. */
  valuedAt: number | null
  /** Alguna abierta no tiene precio y no está en `unrealized`. */
  marksIncomplete: boolean
  hasTrades: boolean
  closedCount: number
  wonCount: number
  /** El titular de Resumen, tal cual (frase de `@sereno/core`). */
  text: string
  /** El veredicto corto, tal cual llegó en el snapshot. */
  verdict: HeadlineVerdict | null
}

export function deriveHeadline(snapshot: HeadlineSnapshot, open: readonly Position[], marks: Marks, now: number): HeadlineView {
  const valuations = open.map((p) => valuePosition(p, marks))
  const gross = valuations.reduce((sum, v) => sum + (v.unrealized ?? 0), 0)
  // El saldo ya descontó lo que pagaron las abiertas; esos costos se cuentan del lado de lo
  // abierto (como en cada fila), así lo cerrado es exactamente la suma de `pnlNet`. Lo pagado
  // por una abierta sin precio también queda en lo abierto: cerrado + abierto = total siempre.
  const openCosts = open.reduce((sum, p) => sum + p.feesPaid + p.fundingPaid, 0)
  const equity = snapshot.saldo + gross
  const total = equity - snapshot.capitalInicial
  const realized = snapshot.saldo - snapshot.capitalInicial + openCosts
  const unrealized = gross - openCosts
  const offline = isOffline(snapshot.lastHeartbeat, now)
  // `headline` recibe la hora sólo si hay abiertas valuadas con precio viejo (traspaso de Task 11).
  const valuedAt = offline && open.length > 0 ? snapshot.marksAt : null
  const hasTrades = snapshot.closedCount > 0 || open.length > 0

  const text = headline({
    total,
    realized,
    unrealized,
    sinceLabel: sinceLabel(snapshot.startedAt, now),
    hasTrades,
    ...(valuedAt === null ? {} : { offline: { at: formatTimeBA(valuedAt) } }),
  })

  return {
    equity,
    total,
    realized,
    unrealized,
    today: equity - snapshot.equityAtDayStart,
    signsDiffer:
      Math.abs(total) >= SHOWN_THRESHOLD && Math.abs(realized) >= SHOWN_THRESHOLD && Math.sign(total) !== Math.sign(realized),
    offline,
    valuedAt,
    marksIncomplete: valuations.some((v) => v.mark === null),
    hasTrades,
    closedCount: snapshot.closedCount,
    wonCount: snapshot.wonCount,
    text,
    verdict: snapshot.verdict,
  }
}

export type AccountBasis = Pick<LedgerView, 'capitalInicial' | 'saldo' | 'protegido' | 'baseBlindaje'>

/** Estado de capital con las mismas reglas que el bot (`Account` de core): base, operable, margen en uso. */
export function deriveAccount(
  basis: AccountBasis,
  capital: Settings['capital'],
  open: readonly Position[],
  marks: Marks,
): AccountSnapshot {
  const account = new Account({
    capitalInicial: basis.capitalInicial,
    reinvest: capital.reinvest,
    protectPct: capital.protectPct,
    onShield: capital.onShield,
    saldo: basis.saldo,
    protegido: basis.protegido,
    baseBlindaje: basis.baseBlindaje,
  })
  return account.snapshot(open, marks)
}

/**
 * El bot se pausó solo porque el capital está blindado y no queda ganancia para operar
 * (tercer estado de "Tu capital"). Las únicas pausas automáticas son ésta y la del
 * drawdown, que tiene su propia bandera.
 */
export function isPausedByShield(live: Pick<LivePayload, 'settings' | 'botStatus'> & { ledger: Pick<LedgerView, 'protegido'> }): boolean {
  const pause = live.settings?.pause
  return pause?.paused === true && pause.by === 'auto' && live.ledger.protegido > 0 && live.botStatus?.flags.drawdownPause !== true
}

export type CapitalCardLive = Pick<LivePayload, 'settings' | 'botStatus' | 'market'> & {
  ledger: AccountBasis
  open: readonly Position[]
}

/**
 * La tarjeta "Tu capital" (frase `capitalCard` de core) con la cuenta valuada a las marcas
 * en vivo. `shieldedAt` es `ResumenData.shieldedAt`. Null si la sesión no tiene ajustes.
 */
export function deriveCapitalCard(live: CapitalCardLive, shieldedAt: number | null): CapitalCard | null {
  if (!live.settings) return null
  const { capital } = live.settings
  return capitalCard({
    account: deriveAccount(live.ledger, capital, live.open, marksOf(live.market)),
    protectPct: capital.protectPct,
    shieldedAt,
    pausedByShield: isPausedByShield(live),
  })
}
