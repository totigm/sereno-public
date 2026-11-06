'use client'

import Link from 'next/link'
import type { SessionSummary } from '@/lib/queries/aprendizaje'
import { ReplaysList } from './replays-list'

export interface AprendizajeFirstRunProps {
  /** Replays y simulaciones archivadas que quedaron de antes (puede no haber ninguna). */
  sessions: SessionSummary[]
  now: number
}

/**
 * Aprendizaje sin simulación (spec §11.1, primer uso): el vacío invita a empezar. Sin
 * simulación activa no hay a quién pedirle un replay, pero los que hubo se pueden abrir.
 */
export function AprendizajeFirstRun({ sessions, now }: AprendizajeFirstRunProps) {
  return (
    <div className="column flex flex-col pt-6">
      <header className="flex flex-col gap-2">
        <h1 className="headline max-w-[34rem]">Todavía no aprendí nada: necesito trades cerrados.</h1>
        <p className="text-pretty text-muted">
          Cuando empieces a simular y el bot cierre operaciones, acá vas a ver qué cambió y por qué, con el tamaño de cada muestra.
        </p>
      </header>
      <Link
        href="/"
        className="pressable mt-5 inline-flex h-11 items-center justify-center self-start rounded-control bg-ink px-4 text-[0.9375rem] font-medium text-bg"
      >
        Empezar a simular
      </Link>
      {sessions.length > 0 && (
        <ReplaysList sessions={sessions} queued={[]} commands={[]} canAct={false} activeSessionId={null} defaultCapital={0} offline={false} now={now} />
      )}
    </div>
  )
}
