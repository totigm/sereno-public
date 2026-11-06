'use client'

import type { MouseEvent } from 'react'
import { glue } from '@/components/ajustes/glue'
import { journalWhen } from '@/components/aprendizaje/labels'
import type { JournalEntry, JournalView } from '@/lib/queries/journal'
import { JournalEntryRow } from './journal-entry'
import { Section } from './section'

/** Cuántas entradas se ven sin abrir "Ver todo" (spec §11.1). */
export const JOURNAL_PREVIEW = 5

export interface JournalProps {
  journal: JournalView
  /** "Desde ayer: 4 operaciones, 3 ganadas, +US$ 22,10. Miré 30 monedas 32 veces." */
  summary: string
  /** "Ahora" de la sesión, para la columna de hora. */
  now: number
  hrefFor: (tradeId: string) => string
  onOpenTrade: (event: MouseEvent, entry: JournalEntry) => void
  onShowAll: () => void
  className?: string | undefined
}

/**
 * "Lo último que hizo" (spec §11.1): el encabezado del tramo, las cinco entradas más
 * nuevas y "Ver todo". Las entradas con trade abren su hoja.
 */
export function Journal({ journal, summary, now, hrefFor, onOpenTrade, onShowAll, className }: JournalProps) {
  const preview = journal.entries.slice(0, JOURNAL_PREVIEW)
  return (
    <Section
      title="Lo último que hizo"
      className={className}
      action={
        journal.entries.length > 0 && (
          <button
            type="button"
            onClick={onShowAll}
            aria-haspopup="dialog"
            className="pressable -my-2.5 -mr-2 inline-flex min-h-11 items-center rounded-control px-2 text-sm font-medium text-muted hover:text-ink"
          >
            Ver todo
          </button>
        )
      }
    >
      <p className="text-[0.9375rem] text-pretty text-muted">{glue(summary)}</p>
      {preview.length > 0 && (
        <ul className="flex flex-col">
          {preview.map((entry) => (
            <li key={entry.id} className="border-t border-line">
              <JournalEntryRow
                entry={entry}
                when={journalWhen(entry.at, now)}
                link={entry.positionId === null ? null : { href: hrefFor(entry.positionId), onOpen: (event) => onOpenTrade(event, entry) }}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
