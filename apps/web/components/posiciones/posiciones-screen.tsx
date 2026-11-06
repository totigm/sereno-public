'use client'

import { useState } from 'react'
import { Segment } from '@/components/ui/segment'
import { useLiveContext } from '@/lib/live/provider'
import type { PosicionesData } from '@/lib/queries/posiciones'
import type { SessionContext } from '@/lib/queries/session'
import { ClosePositionProvider } from './close-position'
import { ClosedList } from './closed-list'
import { Filters, hasFilters } from './filters'
import { OpenPositions } from './open-positions'
import { PosicionesHeadline } from './posiciones-headline'
import { Stats } from './stats'
import { TradeSheet } from './trade-sheet'
import { tradeScope, type TradeRecord } from './trade-model'
import { useQueryNav } from './use-query-nav'
import { useRefreshOnClose } from './use-refresh-on-close'
import { useTradeParam } from './use-trade-param'
import { VerdictCard } from './verdict-card'

export type PosicionesView = 'abiertas' | 'cerradas' | 'estadisticas'

const VIEWS = [
  { value: 'abiertas', label: 'Abiertas' },
  { value: 'cerradas', label: 'Cerradas' },
  { value: 'estadisticas', label: 'Estadísticas' },
] as const satisfies readonly { value: PosicionesView; label: string }[]

const VIEW_PARAM = 'vista'

function parseView(value: string | null): PosicionesView | null {
  return VIEWS.find((v) => v.value === value)?.value ?? null
}

export interface PosicionesScreenProps {
  /** Lo que trae `getPosicionesData`; las abiertas y los precios salen de la consulta en vivo del shell. */
  data: Omit<PosicionesData, 'live'>
  context: SessionContext
}

/** La pantalla Posiciones (spec §11.1): abiertas, historial de cerradas y estadísticas con el veredicto. */
export function PosicionesScreen({ data, context }: PosicionesScreenProps) {
  const { data: live } = useLiveContext()
  const scope = tradeScope(context, live)
  const nav = useQueryNav()
  const trade = useTradeParam()
  const filtered = hasFilters(data.closed.query)
  // Sin `?vista=`, la que tenga algo que mostrar; se fija al montar para que no salte sola.
  const [fallback] = useState<PosicionesView>(() => (filtered || live.open.length === 0 ? 'cerradas' : 'abiertas'))
  const view = parseView(nav.params.get(VIEW_PARAM)) ?? fallback

  useRefreshOnClose(
    live.open.map((p) => p.id),
    scope.active,
  )

  const known: TradeRecord | null =
    trade.tradeId === null
      ? null
      : (live.open.find((p) => p.id === trade.tradeId) ?? data.closed.items.find((c) => c.id === trade.tradeId) ?? null)

  return (
    <ClosePositionProvider enabled={scope.active} offline={scope.offline}>
      <div className="column-wide flex flex-col pt-6">
        <PosicionesHeadline open={live.open} scope={scope} stats={data.stats} />
        <Segment
          options={VIEWS}
          value={view}
          onChange={(next) => nav.replaceShallow({ [VIEW_PARAM]: next })}
          label="Qué mostrar"
          className="mt-5 self-start"
        />
        <div className="mt-5">
          {view === 'abiertas' && <OpenPositions open={live.open} scope={scope} hrefFor={trade.hrefFor} onOpen={trade.onOpen} />}
          {view === 'cerradas' && (
            <div className="flex flex-col gap-5">
              {(data.closed.symbols.length > 0 || filtered) && (
                <Filters
                  query={data.closed.query}
                  symbols={data.closed.symbols}
                  onChange={(patch) => nav.replace({ ...patch, [VIEW_PARAM]: 'cerradas', pagina: null, trade: null })}
                />
              )}
              <ClosedList
                closed={data.closed}
                scope={scope}
                hrefFor={trade.hrefFor}
                onOpen={trade.onOpen}
                filtered={filtered}
                pending={nav.pending}
              />
            </div>
          )}
          {view === 'estadisticas' && (
            <div className="flex flex-col gap-8">
              <VerdictCard verdict={data.verdict} days={data.session.days} />
              <Stats stats={data.stats} />
            </div>
          )}
        </div>
      </div>
      <TradeSheet tradeId={trade.tradeId} known={known} detail={data.trade} scope={scope} onClose={trade.close} />
    </ClosePositionProvider>
  )
}
