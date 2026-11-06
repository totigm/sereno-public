'use client'

import { useMemo, type MouseEvent } from 'react'
import { useUrlSheet } from '@/components/aprendizaje/use-url-sheet'
import { sessionBase } from '@/components/nav/tabs'
import { ClosePositionProvider } from '@/components/posiciones/close-position'
import { TradeSheet } from '@/components/posiciones/trade-sheet'
import { tradeScope } from '@/components/posiciones/trade-model'
import { useRefreshOnClose } from '@/components/posiciones/use-refresh-on-close'
import { useTradeParam } from '@/components/posiciones/use-trade-param'
import { deriveHeadline, marksOf } from '@/lib/derive'
import { useLiveContext } from '@/lib/live/provider'
import type { JournalEntry } from '@/lib/queries/journal'
import type { ResumenData } from '@/lib/queries/resumen'
import type { SessionContext } from '@/lib/queries/session'
import { useHydrated } from '@/lib/use-hydrated'
import { BotStatus } from './bot-status'
import { CapitalCard } from './capital-card'
import { EquitySection } from './equity-chart'
import { Headline } from './headline'
import { pastHeadline, presentHeadline } from './headline-model'
import { Journal } from './journal'
import { JournalSheet } from './journal-sheet'
import { journalSummary } from './journal-text'
import { LiquidationBand, markLiquidationsSeen, useUnseenLiquidations } from './liquidation-band'
import { OpenPositions } from './open-positions'
import { capitalView } from './resumen-capital'
import { SecondaryLine, secondaryParts } from './secondary-line'
import { SessionReport } from './session-report'
import { useEntrance } from './use-entrance'
import { VerdictLine } from './verdict-line'

export interface ResumenScreenProps {
  /** Lo que trae `getResumenData`; lo que cambia en vivo sale de la consulta del shell. */
  data: Omit<ResumenData, 'live'>
  context: SessionContext
}

/** "Ver todo" del diario, reflejado en la URL (`?diario=todo`). */
const JOURNAL_PARAM = 'diario'

/**
 * La pantalla Resumen (spec §11.1): el titular con el número adentro, la curva, las
 * abiertas, el capital, lo último que hizo y el estado del bot. En un replay o una
 * simulación archivada, todo en pasado, con el reporte en lugar del estado y sin acciones.
 */
export function ResumenScreen({ data, context }: ResumenScreenProps) {
  const { data: live } = useLiveContext()
  const scope = tradeScope(context, live)
  const past = !scope.active
  const trade = useTradeParam()
  const journalSheet = useUrlSheet(JOURNAL_PARAM, 'todo')
  const enter = useEntrance()
  const hydrated = useHydrated()
  // La sesión real también está activa, pero vive en `/s/<id>`: la raíz es la de papel.
  const base = scope.active && data.session.kind !== 'live' ? '' : sessionBase(data.session.id)

  useRefreshOnClose(
    live.open.map((p) => p.id),
    scope.active,
  )

  const { ledger } = live
  const view = deriveHeadline(
    {
      capitalInicial: ledger.capitalInicial,
      startedAt: ledger.startedAt,
      saldo: ledger.saldo,
      equityAtDayStart: ledger.equityAtDayStart,
      closedCount: ledger.closedCount,
      wonCount: ledger.wonCount,
      lastHeartbeat: live.botStatus?.lastHeartbeat ?? null,
      marksAt: live.market?.updatedAt ?? null,
      verdict: data.verdict,
    },
    live.open,
    marksOf(live.market),
    live.now,
  )
  const headline = past ? pastHeadline(view, { replay: context.isReplay, days: data.session.days }) : presentHeadline(view, live.botStatus)
  const pricesAt = past ? null : view.valuedAt
  const capital = capitalView(live, { past, shieldedAt: data.shieldedAt })
  const summary = journalSummary(data.journal, { past })

  // Las liquidaciones del tramo: la banda se va al tocarla; una entrada tocada deja de contar.
  const unseen = useUnseenLiquidations(data.journal.entries)
  const liquidationIds = data.journal.entries.filter((e) => e.kind === 'liquidation').map((e) => e.id)
  const markSeen = (touched: readonly string[]) =>
    markLiquidationsSeen(liquidationIds.filter((id) => touched.includes(id) || !unseen.some((u) => u.id === id)))
  const onlyUnseen = unseen.length === 1 ? unseen[0] : undefined
  const bandTrade = onlyUnseen?.positionId ?? null

  const openTrade = (event: MouseEvent, entry: JournalEntry) => {
    markSeen([entry.id])
    if (entry.positionId !== null) trade.onOpen(event, entry.positionId)
  }

  // El punto de ahora de la curva: un objeto nuevo sólo cuando la consulta en vivo trae otro.
  const showLivePoint = scope.active && !live.offline && view.hasTrades
  const liveShadow = live.equityLast?.shadowEquity ?? null
  const livePoint = useMemo(
    () => (showLivePoint ? { at: live.now, equity: view.equity, saldo: ledger.saldo, shadowEquity: liveShadow } : null),
    [showLivePoint, live.now, view.equity, ledger.saldo, liveShadow],
  )

  return (
    <ClosePositionProvider enabled={scope.active} offline={scope.offline}>
      <div className="column flex flex-col pt-6">
        <header {...enter(0, 'flex flex-col gap-2.5')}>
          <Headline parts={headline} />
          <SecondaryLine parts={secondaryParts(view, { past, openCount: live.open.length, pricesAt })} />
          {view.closedCount > 0 && <VerdictLine verdict={data.verdict} href={`${base}/posiciones?vista=estadisticas`} />}
        </header>

        {scope.active && (
          <LiquidationBand
            unseen={unseen}
            link={bandTrade === null ? null : { href: trade.hrefFor(bandTrade), onOpen: (event) => trade.onOpen(event, bandTrade) }}
            onView={() => {
              markSeen(liquidationIds)
              if (bandTrade === null) journalSheet.show()
            }}
          />
        )}

        <div {...enter(1, 'mt-5')}>
          <EquitySection equity={data.equity} livePoint={livePoint} past={past} now={scope.now} />
        </div>

        {/* La misma geometría que el esqueleto (spec §11.4); lado a lado a 1,3fr / 1fr (spec §11.2). */}
        <div className="mt-7 grid gap-7 desktop:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] desktop:gap-5">
          <div {...enter(2)}>
            <OpenPositions open={live.open} scope={scope} hrefFor={trade.hrefFor} onOpen={trade.onOpen} />
          </div>
          {capital && (
            <div {...enter(3)}>
              <CapitalCard view={capital.view} pricesAt={pricesAt} release={capital.release} />
            </div>
          )}
        </div>

        <div {...enter(4, 'mt-7')}>
          <Journal
            journal={data.journal}
            summary={summary}
            now={scope.now}
            hrefFor={trade.hrefFor}
            onOpenTrade={openTrade}
            onShowAll={journalSheet.show}
          />
        </div>

        <div {...enter(5, 'mt-7')}>
          {scope.active ? (
            <BotStatus live={live} />
          ) : (
            <SessionReport
              session={data.session}
              stats={data.stats}
              realized={view.realized}
              report={data.report}
              now={scope.now}
              statsHref={`${base}/posiciones?vista=estadisticas`}
            />
          )}
        </div>
      </div>

      <TradeSheet
        tradeId={hydrated ? trade.tradeId : null}
        known={trade.tradeId === null ? null : (live.open.find((p) => p.id === trade.tradeId) ?? null)}
        detail={data.trade}
        scope={scope}
        onClose={trade.close}
      />
      <JournalSheet open={hydrated && journalSheet.open} onClose={journalSheet.hide} summary={summary} entries={data.journal.entries} clock={scope.clock} />
    </ClosePositionProvider>
  )
}
