import type { ReactNode } from 'react'

/** Una línea de diario: la hora (o el día) a la izquierda y la frase, como en la Libreta. */
export function JournalEntry({ at, when, children }: { at: number; when: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-t border-line py-2.5">
      <time dateTime={new Date(at).toISOString()} className="w-12 shrink-0 text-muted tabular-nums">
        {when}
      </time>
      <p className="min-w-0 flex-1 text-pretty">{children}</p>
    </li>
  )
}
