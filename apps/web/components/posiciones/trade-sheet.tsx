'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { SkeletonLines } from '@/components/ui/skeleton'
import { formatTimeBA } from '@/lib/format'
import { useLiveContext } from '@/lib/live/provider'
import type { TradeDetail } from '@/lib/queries/posiciones'
import { useClosePosition } from './close-position'
import { CloseStatusLine, isClosing } from './close-status'
import { CLOSE_REASON_LABELS, whenLabel } from './format'
import { TradeChart } from './trade-chart'
import { TradeCosts } from './trade-costs'
import { TradeFacts } from './trade-facts'
import { TradeHead, tradeLayoutId } from './trade-head'
import { isClosed, summarize, type TradeRecord, type TradeScope } from './trade-model'
import { TradeSignals, type TradeSignal } from './trade-signals'
import { TradeTimeline } from './trade-timeline'

export interface TradeSheetProps {
  /** El trade de la hoja (`useTradeParam().tradeId`); null la cierra. */
  tradeId: string | null
  /** Lo que la pantalla ya tiene de ese trade (la fila tocada): la cabecera aparece al instante. */
  known: TradeRecord | null
  /** `getTradeDetail(…)` del servidor; mientras no llega (o es de otro trade) van esqueletos. */
  detail: TradeDetail | null
  scope: TradeScope
  onClose: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5">
      <h3 className="text-[0.9375rem] font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function stateLine(trade: TradeRecord, scope: TradeScope): string {
  if (isClosed(trade)) return `${CLOSE_REASON_LABELS[trade.closeReason]} · cerró ${whenLabel(trade.closedAt, scope.clock)}`
  if (!scope.active) return `Seguía abierta al final · abrió ${whenLabel(trade.openedAt, scope.clock)}`
  if (scope.offline && scope.pricesAt !== null) return `Abierta · precios de las ${formatTimeBA(scope.pricesAt)}`
  return `Abierta desde ${whenLabel(trade.openedAt, scope.clock)}`
}

/** Las señales al abrir con el peso de la moneda; sin el detalle, los valores y el peso por llegar. */
function signalsOf(trade: TradeRecord, detail: TradeDetail | null): TradeSignal[] {
  if (detail) return detail.signals
  return trade.signalsAtOpen.map((s) => ({ id: s.id, value: s.value, weight: null }))
}

/**
 * La hoja de detalle de un trade, abierto o cerrado (spec §11.1, Posiciones): la
 * cabecera es el mismo bloque de la fila (transición compartida), y debajo las velas
 * con los niveles, el motivo, las señales con valor y peso, la línea de tiempo, los
 * números y los costos. Con el trade abierto y el bot conectado, "Cerrar ahora".
 */
export function TradeSheet({ tradeId, known, detail, scope, onClose }: TradeSheetProps) {
  const { data } = useLiveContext()
  const close = useClosePosition()
  const liveOpen = tradeId === null ? undefined : data.open.find((p) => p.id === tradeId)
  const matching = detail?.position.id === tradeId ? detail : null
  // Si el servidor ya la ve cerrada, manda eso; si no, la versión en vivo (valuada a la marca).
  const trade: TradeRecord | null = matching?.closed ? matching.position : (liveOpen ?? matching?.position ?? known)
  const open = tradeId !== null && trade !== null

  // Al cerrarse, `AnimatePresence` sigue mostrando lo último que tenía la hoja.
  if (!trade) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>

  const summary = summarize(trade)
  const stale = scope.offline
  const closing = liveOpen ? isClosing(close.statusOf(liveOpen.symbol)) : false
  const footer =
    liveOpen && (close.available || close.unavailableReason !== null) ? (
      <div className="flex flex-col gap-1">
        <CloseStatusLine position={liveOpen} />
        <Button variant="danger" disabled={!close.available || closing} onClick={() => close.request(liveOpen)} className="w-full">
          Cerrar ahora
        </Button>
        {close.unavailableReason && <p className="pt-1 text-sm text-muted">{close.unavailableReason}</p>}
      </div>
    ) : undefined

  return (
    <Sheet
      open={open}
      onClose={onClose}
      layoutId={tradeLayoutId(trade.id)}
      title={<TradeHead summary={summary} stale={stale} className="text-lg" />}
      {...(footer ? { footer } : {})}
    >
      <div className="flex flex-col gap-5">
        <p className="-mt-1 text-sm text-muted">{stateLine(trade, scope)}</p>
        <TradeChart
          trade={trade}
          detail={matching}
          price={isClosed(trade) ? null : summary.price}
          until={scope.active ? null : scope.now}
          stale={stale}
        />
        <Section title="Por qué entró">
          <p className="text-pretty">{trade.openReason || 'No quedó registrado el motivo de esta apertura.'}</p>
        </Section>
        <Section title="Señales al abrir">
          <TradeSignals signals={signalsOf(trade, matching)} side={trade.side} />
        </Section>
        <Section title="Qué pasó">
          {matching ? <TradeTimeline events={matching.events} clock={scope.clock} /> : <SkeletonLines lines={3} />}
        </Section>
        <Section title="Números">
          <TradeFacts trade={trade} summary={summary} scope={scope} />
        </Section>
        <Section title="Costos">
          <TradeCosts trade={trade} events={matching?.events ?? null} />
        </Section>
      </div>
    </Sheet>
  )
}
