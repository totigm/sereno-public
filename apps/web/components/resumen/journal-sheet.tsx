'use client'

import { glue } from '@/components/ajustes/glue'
import { dayHeading } from '@/components/aprendizaje/labels'
import { Sheet } from '@/components/ui/sheet'
import { formatDateBA, formatTimeBA, startOfDayBA } from '@/lib/format'
import type { JournalEntry } from '@/lib/queries/journal'
import { JournalEntryRow } from './journal-entry'

export interface JournalSheetProps {
  open: boolean
  onClose: () => void
  /** El encabezado del tramo ("Desde ayer: 4 operaciones…"). */
  summary: string
  entries: readonly JournalEntry[]
  /** Reloj para "Hoy" y "Ayer"; null en una sesión terminada (fechas completas). */
  clock: number | null
}

function byDay(entries: readonly JournalEntry[]): { day: number; entries: JournalEntry[] }[] {
  const days = new Map<number, JournalEntry[]>()
  for (const entry of entries) {
    const day = startOfDayBA(entry.at)
    days.set(day, [...(days.get(day) ?? []), entry])
  }
  return [...days.entries()].map(([day, list]) => ({ day, entries: list }))
}

/** "Ver todo" de "Lo último que hizo": el tramo entero, agrupado por día (spec §11.1). */
export function JournalSheet({ open, onClose, summary, entries, clock }: JournalSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Lo último que hizo">
      <p className="text-[0.9375rem] text-pretty text-muted">{glue(summary)}</p>
      {entries.length === 0 ? (
        <p className="mt-5 text-muted">Nada que contar en este tramo.</p>
      ) : (
        byDay(entries).map(({ day, entries: list }) => (
          <section key={day} className="mt-6 flex flex-col">
            <h3 className="pb-1 text-sm font-semibold">{clock === null ? formatDateBA(day) : dayHeading(day, clock)}</h3>
            <ul>
              {list.map((entry) => (
                <li key={entry.id} className="border-t border-line first:border-t-0">
                  <JournalEntryRow entry={entry} when={formatTimeBA(entry.at)} link={null} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Sheet>
  )
}
