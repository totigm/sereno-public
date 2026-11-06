'use client'

import clsx from 'clsx'
import { useState } from 'react'
import type { SymbolStats as SymbolStatsRow } from '@sereno/core/src/stats/stats'
import { Segment } from '@/components/ui/segment'
import { formatPct } from '@/lib/format'
import { coinName } from './format'
import { ResultText } from './result-text'

type SortKey = 'resultado' | 'trades' | 'acierto'

const SORTS = [
  { value: 'resultado', label: 'Resultado' },
  { value: 'trades', label: 'Trades' },
  { value: 'acierto', label: 'Acierto' },
] as const

type Row = SymbolStatsRow & { symbol: string }

const ORDER: Record<SortKey, (a: Row, b: Row) => number> = {
  resultado: (a, b) => b.pnlNet - a.pnlNet,
  trades: (a, b) => b.trades - a.trades || b.pnlNet - a.pnlNet,
  acierto: (a, b) => b.winRate - a.winRate || b.trades - a.trades,
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const COLUMNS = 'desktop:grid desktop:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr_1fr] desktop:items-center desktop:gap-x-5'

/**
 * Por moneda (spec §11.1): en el celu filas "SOL · 6 trades · 4 ganados · +US$ 31,20",
 * en desktop una tabla; las dos ordenadas por el mismo segmento.
 */
export function SymbolStats({ bySymbol }: { bySymbol: Record<string, SymbolStatsRow> }) {
  const [sort, setSort] = useState<SortKey>('resultado')
  const rows = Object.entries(bySymbol)
    .map(([symbol, s]) => ({ ...s, symbol }))
    .sort((a, b) => ORDER[sort](a, b) || a.symbol.localeCompare(b.symbol))

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Por moneda</h3>
        <Segment options={SORTS} value={sort} onChange={setSort} label="Ordenar monedas por" />
      </div>
      <div role="table" aria-label="Resultados por moneda" className="panel px-4 desktop:px-5">
        <div role="rowgroup" className="hidden desktop:block">
          <div role="row" className={clsx(COLUMNS, 'h-11 text-sm text-muted')}>
            <span role="columnheader">Moneda</span>
            <span role="columnheader" className="text-right">Trades</span>
            <span role="columnheader" className="text-right">Ganados</span>
            <span role="columnheader" className="text-right">Acierto</span>
            <span role="columnheader" className="text-right">Resultado en US$</span>
          </div>
        </div>
        <div role="rowgroup" className="divide-y divide-line desktop:border-t desktop:border-line">
          {rows.map((row) => {
            const coin = coinName(row.symbol)
            return (
              <div key={row.symbol} role="row" className={clsx(COLUMNS, 'flex min-h-12 items-center justify-between gap-3 py-2 tabular-nums')}>
                <span role="cell" className="min-w-0">
                  <span className="font-semibold">{coin}</span>
                  <span className="text-muted desktop:hidden">
                    {' · '}
                    <span className="whitespace-nowrap">{plural(row.trades, 'trade', 'trades')}</span> ·{' '}
                    <span className="whitespace-nowrap">{plural(row.wins, 'ganado', 'ganados')}</span>
                  </span>
                </span>
                <span role="cell" className="hidden text-right desktop:block">{row.trades}</span>
                <span role="cell" className="hidden text-right desktop:block">{row.wins}</span>
                <span role="cell" className="hidden text-right text-muted desktop:block">{formatPct(row.winRate, 0, false)}</span>
                <span role="cell" className="text-right">
                  <span className="sr-only desktop:hidden"> · </span>
                  <ResultText value={row.pnlNet} dense />
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
