import type { SessionView } from '@/lib/queries/session'
import { replayStatusLabel } from '@/components/nav/session-labels'
import { replayParamsLabel } from './labels'
import { ReplayProgress } from './replay-progress'

/** Cómo se corrió un replay terminado y qué concluyó (el veredicto que dejó el bot en `mensaje`). */
export function ReplaySummary({ session }: { session: SessionView }) {
  if (!session.replayParams && !session.mensaje) return null
  return (
    <div className="panel mt-6 flex flex-col gap-1 p-4 text-sm">
      {session.replayParams && <p className="text-muted">{`Se corrió con ${replayParamsLabel(session.replayParams)}.`}</p>}
      {session.mensaje && <p className="text-pretty">{session.mensaje}</p>}
    </div>
  )
}

const TITLES: Partial<Record<SessionView['status'], string>> = {
  en_cola: 'Este replay está en cola.',
  descargando: 'Este replay todavía está corriendo.',
  simulando: 'Este replay todavía está corriendo.',
  fallido: 'Este replay no pudo terminar.',
  cancelado: 'Este replay se canceló antes de terminar.',
}

/**
 * Un replay que no terminó bien no tiene aprendizaje para mostrar: en su lugar, en qué
 * está (con el avance si corre) o qué pasó. Null si el replay está listo. `whenDone` es
 * lo que se va a ver al terminar, según la pantalla.
 */
export function ReplayState({ session, whenDone = 'Cuando termine, acá vas a ver qué aprendió.' }: { session: SessionView; whenDone?: string }) {
  const title = TITLES[session.status]
  if (session.kind !== 'replay' || title === undefined) return null
  const running = session.status === 'descargando' || session.status === 'simulando'
  const detail = running
    ? whenDone
    : session.status === 'en_cola'
      ? 'Arranca cuando el bot lo tome.'
      : (session.mensaje ?? 'El bot no dejó el motivo.')

  return (
    <header className="flex flex-col gap-2">
      <h1 className="headline max-w-[34rem]">{title}</h1>
      <p className="text-pretty text-muted">{detail}</p>
      {running && (
        <div className="panel mt-4 flex flex-col gap-2.5 p-4">
          <p className="font-medium">{replayStatusLabel(session)}</p>
          <ReplayProgress value={session.progreso ?? 0} label={`Avance de ${session.name}`} />
          {session.replayParams && <p className="text-sm text-muted">{replayParamsLabel(session.replayParams)}</p>}
        </div>
      )}
    </header>
  )
}
