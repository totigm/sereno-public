import { formatNumber, formatUsd } from '@/lib/format'
import type { PositionEventView } from '@/lib/queries/posiciones'
import { isClosed, type TradeRecord } from './trade-model'

/** Costos en US$; el funding con signo (positivo = pagado). null: no se sabe todavía. */
export interface TradeCostsView {
  fees: number
  spread: number | null
  slippage: number | null
  funding: number
}

// El evento de apertura guarda el spread y el slippage de la entrada (`position_opened`
// = `{ price, qty, fee, spreadCost, slippageCost }`, contrato con el bot).
function entryCost(events: PositionEventView[] | null, key: 'spreadCost' | 'slippageCost'): number | null {
  const value = events?.find((e) => e.kind === 'open')?.payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Los de una cerrada, completos; los de una abierta, lo pagado hasta ahora. */
export function costsOf(trade: TradeRecord, events: PositionEventView[] | null): TradeCostsView {
  if (isClosed(trade)) return trade.costs
  return { fees: trade.feesPaid, spread: entryCost(events, 'spreadCost'), slippage: entryCost(events, 'slippageCost'), funding: trade.fundingPaid }
}

/** Lo que efectivamente costó (el funding cobrado resta); null si falta algún dato. */
export function costTotal(c: TradeCostsView): number | null {
  return c.spread === null || c.slippage === null ? null : c.fees + c.spread + c.slippage + c.funding
}

const usd = (n: number | null) => (n === null ? '—' : formatUsd(n))

/** Costos de la hoja (spec §11.1), con el total y lo que se llevan del riesgo. */
export function TradeCosts({ trade, events }: { trade: TradeRecord; events: PositionEventView[] | null }) {
  const costs = costsOf(trade, events)
  const total = costTotal(costs)
  const closed = isClosed(trade)
  const lines = [
    { label: 'Comisiones', value: costs.fees },
    { label: 'Spread', value: costs.spread },
    { label: 'Slippage', value: costs.slippage },
    { label: costs.funding < 0 ? 'Funding cobrado' : 'Funding pagado', value: Math.abs(costs.funding) },
  ]

  return (
    <div className="flex flex-col gap-2">
      <dl className="divide-y divide-line text-sm">
        {lines.map((line) => (
          <div key={line.label} className="flex h-9 items-center justify-between gap-3">
            <dt className="text-muted">{line.label}</dt>
            <dd className="tabular-nums">{usd(line.value)}</dd>
          </div>
        ))}
        <div className="flex h-10 items-center justify-between gap-3 font-semibold">
          <dt>{closed ? 'Total' : 'Total hasta ahora'}</dt>
          <dd className="tabular-nums">{usd(total)}</dd>
        </div>
      </dl>
      {total !== null && trade.riesgoReal > 0 && (
        <p className="text-sm text-pretty text-muted">
          Los costos se llevaron {formatNumber(total / trade.riesgoReal, 2)}R del riesgo de {formatUsd(trade.riesgoReal)}.
          {!closed && ' Al cerrar se suma la comisión de salida.'}
        </p>
      )}
    </div>
  )
}
