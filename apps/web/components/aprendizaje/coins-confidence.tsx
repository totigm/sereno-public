'use client'

import clsx from 'clsx'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { formatPct, formatSigned } from '@/lib/format'
import type { CoinLearningRow } from '@/lib/queries/aprendizaje'
import { plural, shortDate } from './labels'
import { Section } from './section'
import { COMPACT_ON_DESKTOP } from './touch'

/** Monedas a la vista antes de "Ver las N monedas". */
const SHOWN = 8

export interface CoinsConfidenceProps {
  coins: CoinLearningRow[]
  past: boolean
  now: number
}

// Primero lo que achica el tamaño: las monedas en penitencia (la que vuelve antes,
// primero) y después de menor a mayor confianza.
function byConcern(a: CoinLearningRow, b: CoinLearningRow): number {
  if ((a.penaltyUntil === null) !== (b.penaltyUntil === null)) return a.penaltyUntil === null ? 1 : -1
  if (a.penaltyUntil !== null && b.penaltyUntil !== null && a.penaltyUntil !== b.penaltyUntil) return a.penaltyUntil - b.penaltyUntil
  return a.confidence - b.confidence || a.symbol.localeCompare(b.symbol)
}

/** Monedas (spec §8.2, §11.1.4): confianza aprendida, cuánto achica el tamaño y penitencias. */
export function CoinsConfidence({ coins, past, now }: CoinsConfidenceProps) {
  const [expanded, setExpanded] = useState(false)
  const sorted = [...coins].sort(byConcern)
  const shown = expanded ? sorted : sorted.slice(0, SHOWN)

  return (
    <Section title="Monedas" description="La confianza en una moneda sólo achica el tamaño de sus trades: nunca lo agranda.">
      {coins.length === 0 ? (
        <p className="border-t border-line pt-3 text-muted">{past ? 'No operó ninguna moneda.' : 'Todavía no operé ninguna moneda.'}</p>
      ) : (
        <>
          <ul className="border-b border-line">
            {shown.map((coin) => (
              <CoinRow key={coin.symbol} coin={coin} now={now} />
            ))}
          </ul>
          {sorted.length > SHOWN && (
            <Button
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={clsx(COMPACT_ON_DESKTOP, '-ml-4 self-start desktop:-ml-3')}
            >
              {expanded ? 'Ver menos' : `Ver las ${sorted.length} monedas`}
            </Button>
          )}
        </>
      )}
    </Section>
  )
}

function CoinRow({ coin, now }: { coin: CoinLearningRow; now: number }) {
  const { penaltyUntil } = coin
  const penalized = penaltyUntil !== null
  // Se compara lo que se muestra: 0,998 se lee "100%" y es, a la vista, el tamaño completo.
  const size = formatPct(coin.multiplier, 0, false)
  const detail = [plural(coin.trades, 'trade', 'trades'), size === formatPct(1, 0, false) ? 'tamaño completo' : `tamaño ${size}`].join(' · ')
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_4.5rem_3rem] items-center gap-3 border-t border-line py-2.5 desktop:grid-cols-[minmax(0,1fr)_10rem_3.5rem]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{coin.name}</span>
          {penaltyUntil !== null && <Chip tone="loss">{`En penitencia hasta el ${shortDate(penaltyUntil, now)}`}</Chip>}
        </p>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <ConfidenceBar value={coin.confidence} dimmed={penalized} />
      <span className={clsx('text-right font-medium tabular-nums', penalized && 'text-muted')}>{formatSigned(coin.confidence, 2)}</span>
    </li>
  )
}

/** Barra divergente de −1 a 1 desde el centro; el signo va también en el número de al lado. */
function ConfidenceBar({ value, dimmed }: { value: number; dimmed: boolean }) {
  const half = Math.min(1, Math.abs(value)) * 50
  return (
    <div aria-hidden className={clsx('relative h-1.5 rounded-chip bg-ink/6', dimmed && 'opacity-60')}>
      <span className="absolute top-[-3px] left-1/2 h-3 w-px -translate-x-1/2 bg-muted/60" />
      <span
        className={clsx('absolute inset-y-0 rounded-chip', value >= 0 ? 'bg-gain' : 'bg-loss')}
        style={value >= 0 ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` }}
      />
    </div>
  )
}
