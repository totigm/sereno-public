'use client'

import clsx from 'clsx'
import Link from 'next/link'
import { useId, type ReactNode } from 'react'
import type { ReplayParams } from '@sereno/db'
import { contextBandLabel, replayStatusLabel } from '@/components/nav/session-labels'
import { Button } from '@/components/ui/button'
import { formatUsd } from '@/lib/format'
import type { CommandView } from '@/lib/live/types'
import type { SessionSummary } from '@/lib/queries/aprendizaje'
import type { SessionView } from '@/lib/queries/session'
import { periodLabel, plural, replayParamsLabel, whenPhrase } from './labels'
import { OfflineNote } from './offline-note'
import type { CancelProgress } from './replay-cancel'
import { ReplayProgress } from './replay-progress'
import { COMPACT_ON_DESKTOP } from './touch'

// Las filas de "Replays y simulaciones": un pedido en cola, la simulación activa, una
// archivada y un replay en cada estado. Las acciones las decide la lista.

const RUNNING = new Set<SessionView['status']>(['en_cola', 'descargando', 'simulando'])

export function isReplayRunning(session: SessionView): boolean {
  return session.kind === 'replay' && RUNNING.has(session.status)
}

export function asReplayParams(payload: Record<string, unknown>): ReplayParams | null {
  const { days, capital, learningOrigin, paramTuning } = payload
  if (typeof days !== 'number' || typeof capital !== 'number' || typeof paramTuning !== 'boolean') return null
  if (learningOrigin !== 'zero' && learningOrigin !== 'current') return null
  return { days, capital, learningOrigin, paramTuning }
}

interface CancelButtonProps {
  busy: boolean
  onClick: () => void
  disabled?: boolean
  /** El id de la explicación cuando está apagado. */
  describedBy?: string | undefined
}

function CancelButton({ busy, onClick, disabled = false, describedBy }: CancelButtonProps) {
  return (
    <Button onClick={onClick} pending={busy} disabled={disabled} aria-describedby={describedBy} className={clsx(COMPACT_ON_DESKTOP, 'relative z-10 shrink-0')}>
      Cancelar
    </Button>
  )
}

interface RowProps {
  title: ReactNode
  action?: ReactNode
  children: ReactNode
}

/** Fila de la lista; si el título es un enlace, toda la fila lo es (salvo el botón). */
function Row({ title, action, children }: RowProps) {
  return (
    <li className="relative flex items-start gap-3 border-t border-line py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">{title}</p>
        {children}
      </div>
      {action}
    </li>
  )
}

function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="underline-offset-4 after:absolute after:inset-0 after:content-[''] hover:underline">
      {children}
    </Link>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-pretty text-muted">{children}</p>
}

export interface QueuedRowProps {
  command: CommandView
  offline: boolean
  /** Sacarlo de la cola no necesita al bot: también sin conexión. Null fuera de la simulación activa. */
  onRemove: (() => void) | null
  busy: boolean
}

export function QueuedRow({ command, offline, onRemove, busy }: QueuedRowProps) {
  const params = asReplayParams(command.payload)
  return (
    <Row title={params ? `Replay de ${params.days} días` : 'Replay'} action={onRemove && <CancelButton busy={busy} onClick={onRemove} />}>
      <p className="text-sm">{`En cola · ${offline ? 'arranca cuando el bot vuelva' : 'esperando al bot'}`}</p>
      {params && <Muted>{replayParamsLabel(params)}</Muted>}
    </Row>
  )
}

function ResultLine({ item }: { item: SessionSummary }) {
  return (
    <p className="text-sm tabular-nums">
      <span className={clsx('font-medium', item.pnl > 0 && 'text-gain', item.pnl < 0 && 'text-loss')}>{formatUsd(item.pnl, { sign: true })}</span>
      <span className="text-muted">{` · ${plural(item.trades, 'trade', 'trades')}, ${plural(item.won, 'ganado', 'ganados')}`}</span>
    </p>
  )
}

/** Lo que la lista sabe del "Cancelar" de un replay que corre. */
export interface RowCancel {
  onCancel: () => void
  /** El pedido está saliendo (la acción todavía no contestó). */
  sending: boolean
  progress: CancelProgress
}

export interface SessionRowProps {
  item: SessionSummary
  now: number
  offline: boolean
  /** Null fuera de la simulación activa: la fila sólo navega. */
  cancel: RowCancel | null
}

export function SessionRow({ item, now, offline, cancel }: SessionRowProps) {
  const { session } = item
  if (session.kind !== 'replay') {
    // La activa vive en las rutas raíz: `/s/<id de la activa>` no se genera.
    if (session.status === 'active') {
      return (
        <Row title={<RowLink href="/">Simulación en curso</RowLink>}>
          <Muted>{`Desde ${whenPhrase(session.startedAt, now)} · ${plural(item.trades, 'trade cerrado', 'trades cerrados')}`}</Muted>
        </Row>
      )
    }
    return (
      <Row title={<RowLink href={`/s/${session.id}`}>{contextBandLabel(session)}</RowLink>}>
        <ResultLine item={item} />
      </Row>
    )
  }

  const title = <RowLink href={`/s/${session.id}`}>{session.name}</RowLink>
  const params = session.replayParams ? replayParamsLabel(session.replayParams) : null

  if (isReplayRunning(session)) return <RunningRow session={session} title={title} params={params} offline={offline} cancel={cancel} />
  if (session.status === 'listo') {
    return (
      <Row title={title}>
        <ResultLine item={item} />
        <Muted>{[periodLabel(session.period, now), ...(params ? [params] : [])].join(' · ')}</Muted>
        {session.mensaje && <Muted>{session.mensaje}</Muted>}
      </Row>
    )
  }
  if (session.status === 'fallido') {
    return (
      <Row title={title}>
        <p className="text-sm text-loss">{replayStatusLabel(session)}</p>
        {session.mensaje && <Muted>{session.mensaje}</Muted>}
      </Row>
    )
  }
  return (
    <Row title={title}>
      <Muted>{session.mensaje ?? replayStatusLabel(session)}</Muted>
    </Row>
  )
}

interface RunningRowProps {
  session: SessionView
  title: ReactNode
  params: string | null
  offline: boolean
  cancel: RowCancel | null
}

/** Un replay en cola o corriendo: su avance y "Cancelar", que sin el bot queda apagado (spec §11.1). */
function RunningRow({ session, title, params, offline, cancel }: RunningRowProps) {
  const offlineNoteId = useId()
  const cancelling = cancel !== null && (cancel.sending || cancel.progress.kind === 'cancelling')
  const failure = cancel?.progress.kind === 'failed' ? cancel.progress.message : null
  const action = cancel && (
    <CancelButton busy={cancelling} onClick={cancel.onCancel} disabled={offline} describedBy={offline ? offlineNoteId : undefined} />
  )

  return (
    <Row title={title} action={action}>
      <p className="text-sm">{cancelling ? 'Cancelando…' : replayStatusLabel(session)}</p>
      {session.status !== 'en_cola' && <ReplayProgress value={session.progreso ?? 0} label={`Avance de ${session.name}`} className="my-1.5 max-w-80" />}
      {params && <Muted>{params}</Muted>}
      {failure && <p className="text-sm text-pretty text-loss">{failure}</p>}
      {cancel && offline && <OfflineNote id={offlineNoteId} verb="cancelar" />}
    </Row>
  )
}
