'use client'

import clsx from 'clsx'
import { useMemo } from 'react'
import type { ChartLine, ChartMarker, ChartTone } from '@/components/charts/candle-chart'
import { LazyCandleChart } from '@/components/charts/lazy-candle-chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { TradeDetail } from '@/lib/queries/posiciones'
import { formatPrice } from './format'
import { isClosed, type TradeRecord } from './trade-model'

/** El stop a lo largo del trade: el inicial y cada movimiento (`stop_moved` = `{ from, to }`). */
export function stopPath(
  trade: Pick<TradeRecord, 'openedAt' | 'stopPrice'>,
  events: TradeDetail['events'],
): { at: number; value: number }[] {
  const moves = events.flatMap((e) => {
    const { from, to } = e.payload
    return e.kind === 'stop_moved' && typeof from === 'number' && typeof to === 'number' ? [{ at: e.at, from, to }] : []
  })
  const first = moves[0]
  return [{ at: trade.openedAt, value: first ? first.from : trade.stopPrice }, ...moves.map((m) => ({ at: m.at, value: m.to }))]
}

export interface TradeChartProps {
  trade: TradeRecord
  /** null mientras llega del servidor: va el esqueleto con el mismo alto. */
  detail: TradeDetail | null
  /** Precio vigente de una abierta (null cerrada o sin precio). */
  price: number | null
  /**
   * El final de una sesión terminada: ahí se cortan los niveles de una abierta y va su marca.
   * Null en la activa: llegan hasta la última vela que trajo el servidor, así el gráfico no
   * se rearma con cada refresco de precios.
   */
  until: number | null
  stale: boolean
}

function Swatch({ tone, kind }: { tone: string; kind: 'line' | 'dashed' | 'dot' }) {
  if (kind === 'dot') return <span aria-hidden className={clsx('size-2 shrink-0 rounded-full', tone)} />
  return (
    <span aria-hidden className={clsx('h-0 w-4 shrink-0 border-t-2', tone, kind === 'dashed' && 'border-dashed border-t')} />
  )
}

/** Velas de 15 m con la entrada, el stop (escalonado si se movió), el take profit y la salida (spec §11.1). */
export function TradeChart({ trade, detail, price, until, stale }: TradeChartProps) {
  const closed = isClosed(trade)
  const won = closed && trade.pnlNet > 0
  const { side, entryPrice, stopPrice, takeProfitPrice, openedAt } = trade
  const end = closed ? trade.closedAt : (until ?? detail?.candles.at(-1)?.closeTime ?? openedAt)

  const { lines, markers } = useMemo(() => {
    const stop = stopPath({ openedAt, stopPrice }, detail?.events ?? [])
    const flat = (value: number) => [
      { at: openedAt, value },
      { at: end, value },
    ]
    const lines: ChartLine[] = [
      { id: 'entry', points: flat(entryPrice), tone: 'ink', dashed: true },
      { id: 'stop', points: [...stop, { at: end, value: stop.at(-1)?.value ?? stopPrice }], tone: 'loss', step: true },
      ...(takeProfitPrice === null ? [] : [{ id: 'tp', points: flat(takeProfitPrice), tone: 'gain' as const }]),
    ]
    const long = side === 'long'
    // La salida, en el color del resultado; una abierta de una sesión terminada, su final (el precio
    // de la leyenda). En la activa no hay marca: las velas son de cuando se abrió la hoja y el precio no.
    const endTone: ChartTone | null = closed ? (won ? 'gain' : 'loss') : until === null ? null : 'ink'
    const markers: ChartMarker[] = [
      { at: openedAt, tone: 'ink', shape: long ? 'arrowUp' : 'arrowDown', position: long ? 'belowBar' : 'aboveBar' },
      ...(endTone === null ? [] : [{ at: end, tone: endTone, shape: 'circle', position: long ? 'aboveBar' : 'belowBar' } as const]),
    ]
    return { lines, markers }
  }, [side, entryPrice, stopPrice, takeProfitPrice, openedAt, detail, end, until, closed, won])

  const firstStop = stopPath(trade, detail?.events ?? [])[0]?.value ?? trade.stopPrice
  const legend = [
    { label: 'Entrada', value: formatPrice(trade.entryPrice), swatch: <Swatch tone="border-ink" kind="dashed" /> },
    {
      label: 'Stop',
      value: formatPrice(trade.stopPrice),
      note: firstStop === trade.stopPrice ? null : `arrancó en ${formatPrice(firstStop)}`,
      swatch: <Swatch tone="border-loss" kind="line" />,
    },
    {
      label: 'Take profit',
      value: trade.takeProfitPrice === null ? 'sin take profit' : formatPrice(trade.takeProfitPrice),
      swatch: <Swatch tone="border-gain" kind="line" />,
    },
    closed
      ? { label: 'Salida', value: formatPrice(trade.exitPrice), swatch: <Swatch tone={won ? 'bg-gain' : 'bg-loss'} kind="dot" /> }
      : {
          label: until === null ? 'Precio' : 'Al final',
          value: price === null ? 'sin precio' : formatPrice(price),
          swatch: <Swatch tone="bg-ink" kind="dot" />,
          muted: stale,
        },
  ]

  return (
    <div className="flex flex-col gap-3">
      {detail ? (
        <LazyCandleChart
          candles={detail.candles}
          lines={lines}
          markers={markers}
          label={`Velas de 15 minutos con la entrada, el stop, el take profit${closed ? ' y la salida' : ''} del trade.`}
        />
      ) : (
        <Skeleton className="h-[220px] w-full desktop:h-[260px]" />
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm desktop:grid-cols-4">
        {legend.map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col">
            <dt className="flex items-center gap-2 text-muted">
              {item.swatch}
              {item.label}
            </dt>
            <dd className={clsx('tabular-nums', 'muted' in item && item.muted ? 'text-muted' : 'text-ink')}>{item.value}</dd>
            {'note' in item && item.note && <dd className="text-xs text-muted tabular-nums">{item.note}</dd>}
          </div>
        ))}
      </dl>
    </div>
  )
}
