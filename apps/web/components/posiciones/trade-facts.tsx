import { formatUsdRound } from '@sereno/core/src/journal/format'
import { formatSigned } from '@/lib/format'
import { durationLabel, formatPrice } from './format'
import { isClosed, type TradeRecord, type TradeScope, type TradeSummary } from './trade-model'

/** Los números del trade: cuánto puso, cuánto arriesgó, dónde lo liquidaban, cuánto duró y en R. */
export function TradeFacts({ trade, summary, scope }: { trade: TradeRecord; summary: TradeSummary; scope: TradeScope }) {
  const closed = isClosed(trade)
  const facts = [
    { label: 'Margen', value: formatUsdRound(trade.margin) },
    { label: 'Nocional', value: formatUsdRound(Math.round(trade.notional)) },
    { label: 'Riesgo', value: formatUsdRound(trade.riesgoReal) },
    { label: 'Liquidación', value: formatPrice(trade.liquidationPrice) },
    {
      // Una que siguió abierta al final de una sesión terminada se cuenta hasta ese final.
      label: closed ? 'Duró' : scope.active ? 'Abierta hace' : 'Abierta durante',
      value: durationLabel((closed ? trade.closedAt : scope.now) - trade.openedAt),
    },
    { label: 'Resultado en R', value: summary.r === null ? '—' : `${formatSigned(summary.r, 2)}R` },
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm desktop:grid-cols-3">
      {facts.map((f) => (
        <div key={f.label} className="flex flex-col">
          <dt className="text-muted">{f.label}</dt>
          <dd className="font-medium tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}
