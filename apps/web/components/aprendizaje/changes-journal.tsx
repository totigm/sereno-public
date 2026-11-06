'use client'

import clsx from 'clsx'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { formatTimeBA, startOfDayBA } from '@/lib/format'
import type { LearningLogPage, LearningLogView } from '@/lib/queries/aprendizaje'
import { cursorParam, JOURNAL_LATEST, JOURNAL_PARAM } from './journal-cursor'
import { JournalEntry } from './journal-entry'
import { dayHeading, journalWhen } from './labels'
import { Section } from './section'
import { COMPACT_ON_DESKTOP } from './touch'
import { urlWith, useUrlSheet } from './use-url-sheet'

/** Entradas a la vista; el resto, en la hoja del diario completo. */
const SHOWN = 5

export interface ChangesJournalProps {
  log: LearningLogPage
  /** La página anterior que pidió la URL (`?diario=<cursor>`), o null. */
  older: LearningLogPage | null
  past: boolean
  now: number
}

/** "Qué cambió": el diario de aprendizaje con su frase y su tamaño muestral (spec §8, controles). */
export function ChangesJournal({ log, older, past, now }: ChangesJournalProps) {
  const sheet = useUrlSheet(JOURNAL_PARAM, JOURNAL_LATEST)
  const hasMore = log.entries.length > SHOWN || log.nextCursor !== null

  return (
    <Section
      title="Qué cambió"
      action={
        hasMore ? (
          <Button variant="ghost" onClick={sheet.show} className={clsx(COMPACT_ON_DESKTOP, '-mr-4 shrink-0 desktop:-mr-3')}>
            Ver todo el diario
          </Button>
        ) : undefined
      }
    >
      {log.entries.length === 0 ? (
        <p className="border-t border-line pt-3 text-muted">
          {past ? 'No hubo cambios.' : 'Cada cambio va a quedar acá, con su frase y el tamaño de la muestra.'}
        </p>
      ) : (
        <ol className="border-b border-line">
          {log.entries.slice(0, SHOWN).map((entry) => (
            <JournalEntry key={entry.id} at={entry.at} when={journalWhen(entry.at, now)}>
              {entry.text}
            </JournalEntry>
          ))}
        </ol>
      )}
      <JournalSheet open={sheet.open} onClose={sheet.hide} log={log} older={older} now={now} />
    </Section>
  )
}

interface JournalSheetProps {
  open: boolean
  onClose: () => void
  log: LearningLogPage
  older: LearningLogPage | null
  now: number
}

/** El diario entero, agrupado por día; las páginas anteriores las trae el servidor por la URL. */
function JournalSheet({ open, onClose, log, older, now }: JournalSheetProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const page = older ?? log
  // `replace`: las páginas del diario no se apilan en el historial; "atrás" cierra la hoja.
  const go = (value: string) => startTransition(() => router.replace(urlWith(JOURNAL_PARAM, value), { scroll: false }))

  const footer =
    older !== null || page.nextCursor !== null ? (
      <div className="flex flex-wrap gap-2">
        {older !== null && (
          <Button variant="ghost" onClick={() => go(JOURNAL_LATEST)} disabled={pending} className={COMPACT_ON_DESKTOP}>
            Volver a lo más reciente
          </Button>
        )}
        {page.nextCursor !== null && (
          <Button pending={pending} onClick={() => page.nextCursor && go(cursorParam(page.nextCursor))} className={clsx(COMPACT_ON_DESKTOP, 'ml-auto')}>
            Ver anteriores
          </Button>
        )}
      </div>
    ) : undefined

  return (
    <Sheet open={open} onClose={onClose} title="Diario de aprendizaje" {...(footer ? { footer } : {})}>
      <div className={pending ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {groupByDay(page.entries).map(({ day, entries }) => (
          <section key={day} aria-label={dayHeading(day, now)} className="mb-5 last:mb-0">
            <h3 className="mb-1 text-sm font-semibold">{dayHeading(day, now)}</h3>
            <ol className="border-b border-line">
              {entries.map((entry) => (
                <JournalEntry key={entry.id} at={entry.at} when={formatTimeBA(entry.at)}>
                  {entry.text}
                </JournalEntry>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </Sheet>
  )
}

function groupByDay(entries: LearningLogView[]): { day: number; entries: LearningLogView[] }[] {
  const groups: { day: number; entries: LearningLogView[] }[] = []
  for (const entry of entries) {
    const day = startOfDayBA(entry.at)
    const last = groups.at(-1)
    if (last && last.day === day) last.entries.push(entry)
    else groups.push({ day, entries: [entry] })
  }
  return groups
}
