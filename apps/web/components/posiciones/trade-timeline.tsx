import clsx from 'clsx'
import { formatUsd } from '@/lib/format'
import type { PositionEventView } from '@/lib/queries/posiciones'
import { formatPrice, momentLabel } from './format'

export interface TimelineEntry {
  id: number
  at: number
  text: string
  tone: 'ink' | 'gain' | 'loss' | 'muted'
}

const num = (payload: Record<string, unknown>, key: string): number | null => {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const str = (payload: Record<string, unknown>, key: string): string | null => {
  const v = payload[key]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * Los eventos que cuentan la historia del trade, en la voz del diario. Las órdenes que
 * se ponen y se cancelan son plomería del exchange: el movimiento del stop ya las cuenta.
 * `stop_moved` = `{ from, to, phrase? }` y `funding` = `{ amount }` con positivo = pagado
 * (contrato con el bot, spec §10 y traspaso de la ola C).
 */
export function timelineEntries(events: PositionEventView[]): TimelineEntry[] {
  return events.flatMap((e): TimelineEntry[] => {
    const p = e.payload
    const at = { id: e.id, at: e.at }
    switch (e.kind) {
      case 'open': {
        const price = num(p, 'price')
        return [{ ...at, text: price === null ? 'Abrí la posición.' : `Abrí a ${formatPrice(price)}.`, tone: 'ink' }]
      }
      case 'stop_moved': {
        const from = num(p, 'from')
        const to = num(p, 'to')
        const text = str(p, 'phrase') ?? (from !== null && to !== null ? `Moví el stop de ${formatPrice(from)} a ${formatPrice(to)}.` : 'Moví el stop.')
        return [{ ...at, text, tone: 'ink' }]
      }
      case 'funding': {
        const amount = num(p, 'amount')
        if (amount === null || amount === 0) return []
        return [
          amount > 0
            ? { ...at, text: `Pagué ${formatUsd(amount)} de funding.`, tone: 'muted' }
            : { ...at, text: `Cobré ${formatUsd(-amount)} de funding.`, tone: 'muted' },
        ]
      }
      case 'partial_close': {
        const price = num(p, 'price')
        return [{ ...at, text: price === null ? 'Cerré una parte.' : `Cerré una parte a ${formatPrice(price)}.`, tone: 'ink' }]
      }
      case 'close':
      case 'liquidation': {
        const pnl = num(p, 'pnlNet')
        const price = num(p, 'price')
        const text = str(p, 'phrase') ?? (price === null ? 'Cerré la posición.' : `Cerré a ${formatPrice(price)}.`)
        const tone = e.kind === 'liquidation' || (pnl !== null && pnl < 0) ? 'loss' : pnl !== null && pnl > 0 ? 'gain' : 'ink'
        return [{ ...at, text, tone }]
      }
      case 'order_placed':
      case 'order_cancelled':
        return []
    }
  })
}

// Las frases vienen del bot: que "US$" no quede en una línea y el número en la otra.
const keepAmounts = (text: string) => text.replace(/US\$ /g, 'US$\u00a0')

const DOT: Record<TimelineEntry['tone'], string> = { ink: 'bg-ink', gain: 'bg-gain', loss: 'bg-loss', muted: 'bg-muted' }

/** La línea de tiempo de eventos de la hoja (spec §11.1). */
export function TradeTimeline({ events, clock }: { events: PositionEventView[]; clock: number | null }) {
  const entries = timelineEntries(events)
  if (entries.length === 0) return <p className="text-sm text-muted">Sin eventos registrados todavía.</p>
  return (
    <ol className="relative flex flex-col gap-3 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-line before:content-['']">
      {entries.map((entry) => (
        <li key={entry.id} className="relative flex gap-3 text-sm">
          <span aria-hidden className={clsx('relative mt-[0.4375rem] size-[7px] shrink-0 rounded-full ring-2 ring-surface', DOT[entry.tone])} />
          <span className="flex min-w-0 flex-col desktop:flex-row desktop:gap-3">
            <span className="shrink-0 text-muted tabular-nums desktop:w-36">{momentLabel(entry.at, clock)}</span>
            <span className="text-pretty">{keepAmounts(entry.text)}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
