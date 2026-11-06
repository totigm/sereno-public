import clsx from 'clsx'
import Link from 'next/link'
import { formatLeverage, formatPrice } from '@sereno/core/src/journal/format'
import { TABS, tabHref } from '@/components/nav/tabs'
import { formatPct, formatTimeBA, formatUsd, relativeAge, toneOfShown } from '@/lib/format'
import type { OpenPositionView } from '@/lib/live/types'
import { stateSentence } from './phrases'
import type { TileModel } from './tile-model'

export interface CoinSummaryProps {
  tile: TileModel
  position: OpenPositionView | undefined
  now: number
  past: boolean
  stale: boolean
  /** Hora de los precios (`market_snapshot.updatedAt`): la que se aclara sin conexión. */
  marksAt: number | null
  base: string
}

type Tone = 'gain' | 'loss' | 'muted'

const toneOf = (value: number | null, stale: boolean): Tone => (value === null || stale || value === 0 ? 'muted' : value > 0 ? 'gain' : 'loss')
// El cambio de 24 h, según lo que se lee ("0,0%" va neutro).
const changeToneOf = (change: number, stale: boolean): Tone => (stale ? 'muted' : toneOfShown(change))
const toneText: Record<Tone, string> = { gain: 'text-gain', loss: 'text-loss', muted: 'text-muted' }

const POSITIONS_TAB = TABS.find((t) => t.key === 'posiciones')

/** "ahora 148,30", "148,30 a las 14:32" sin conexión, "al final 148,30" en una sesión terminada. */
function markText(mark: number, past: boolean, stale: boolean, marksAt: number | null): string {
  if (past) return `al final ${formatPrice(mark)}`
  if (stale && marksAt !== null) return `${formatPrice(mark)} a las ${formatTimeBA(marksAt)}`
  return `ahora ${formatPrice(mark)}`
}

/**
 * Lo primero de la hoja: la abierta si la hay (como la tarjeta de Posiciones, spec
 * §11.1), si no el precio con su cambio de 24 h y el estado de la moneda con su porqué.
 */
export function CoinSummary({ tile, position, now, past, stale, marksAt, base }: CoinSummaryProps) {
  if (position) {
    const { net, pctOfMargin, mark } = position.valuation
    const details = [
      `entró a ${formatPrice(position.entryPrice)}`,
      ...(mark === null ? [] : [markText(mark, past, stale, marksAt)]),
      ...(past ? [] : [relativeAge(position.openedAt, now)]),
    ]
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[0.9375rem] font-medium">
          {position.side === 'long' ? 'Long' : 'Short'} {formatLeverage(position.leverage)}
          {net !== null && (
            <>
              {' · '}
              <span className={clsx('tabular-nums', toneText[toneOf(net, stale)])}>
                {formatUsd(net, { sign: true })}
                {pctOfMargin !== null && ` (${formatPct(pctOfMargin)})`}
              </span>
            </>
          )}
        </p>
        <p className="text-[0.8125rem] text-muted">{details.join(' · ')}</p>
        {POSITIONS_TAB && (
          <Link href={tabHref(base, POSITIONS_TAB)} className="mt-1 self-start text-sm font-medium underline decoration-line underline-offset-4 hover:decoration-ink">
            Ver en Posiciones
          </Link>
        )}
      </div>
    )
  }

  const status = stateSentence(tile.state, tile.name, now, past)
  return (
    <div className="flex flex-col gap-1">
      {tile.markPrice !== null && (
        <p className="text-[0.9375rem]">
          <span className="font-medium tabular-nums">{formatPrice(tile.markPrice)}</span>
          {tile.change24h !== null && (
            <>
              {' · '}
              <span className={clsx('tabular-nums', toneText[changeToneOf(tile.change24h, stale)])}>{formatPct(tile.change24h)}</span>
              {' en 24 h'}
            </>
          )}
          {stale && marksAt !== null && <span className="text-muted"> · a las {formatTimeBA(marksAt)}</span>}
        </p>
      )}
      {status !== null && <p className="text-[0.9375rem] text-pretty">{status}</p>}
    </div>
  )
}
