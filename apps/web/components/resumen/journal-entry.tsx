import clsx from 'clsx'
import Link from 'next/link'
import type { MouseEvent } from 'react'
import { glue } from '@/components/ajustes/glue'
import type { JournalEntry } from '@/lib/queries/journal'
import { journalParts } from './journal-text'

export interface JournalEntryRowProps {
  entry: JournalEntry
  /** "14:32", "ayer", "28 oct" (o sólo la hora en la hoja agrupada por día). */
  when: string
  /** Con trade: tocar la entrada abre su hoja. */
  link: { href: string; onOpen: (event: MouseEvent) => void } | null
}

/**
 * Una entrada del diario: la hora y la frase del bot. Las liquidaciones, los stops que
 * no se ejecutaron con el bot caído y los avisos graves de Binance van con el fondo de
 * pérdida tenue (spec §11.1). En la sesión real, lo que trae números de Binance lo dice.
 */
export function JournalEntryRow({ entry, when, link }: JournalEntryRowProps) {
  const { text, source } = journalParts(entry)
  const body = (
    <>
      <span className="text-muted tabular-nums">{when}</span>
      <span className="min-w-0 text-pretty decoration-muted/50 underline-offset-4 [@media(hover:hover)]:group-hover:underline">
        {glue(text)}
        {source !== null && <span className="text-muted"> · {source}</span>}
      </span>
    </>
  )
  const layout = clsx(
    'grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 py-2.5 text-[0.9375rem] leading-snug',
    entry.highlight && '-mx-2.5 rounded-[10px] bg-loss-soft px-2.5',
  )

  if (!link) return <div className={layout}>{body}</div>
  return (
    <Link
      href={link.href}
      scroll={false}
      onClick={link.onOpen}
      className={clsx(
        layout,
        'group rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
      )}
    >
      {body}
    </Link>
  )
}
