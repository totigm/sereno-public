'use client'

import { useLiveContext } from '@/lib/live/provider'
import type { AprendizajeData, LearningLogPage } from '@/lib/queries/aprendizaje'
import type { SessionContext } from '@/lib/queries/session'
import { ChangesJournal } from './changes-journal'
import { CoinsConfidence } from './coins-confidence'
import { Controls } from './controls'
import { LearningHeadline } from './learning-headline'
import { ParamsCard } from './params-card'
import { RefreshWhileRunning } from './refresh-while-running'
import { ReplayState, ReplaySummary } from './replay-report'
import { isReplayRunning } from './replay-rows'
import { ReplaysList } from './replays-list'
import { ShadowCompare } from './shadow-compare'
import { SignalsTable } from './signals-table'

export interface AprendizajeScreenProps {
  data: AprendizajeData
  context: SessionContext
  /** La página anterior del diario que pidió la URL (`?diario=<cursor>`). */
  olderLog?: LearningLogPage | null
}

/**
 * Aprendizaje (spec §8, §11.1.4), igual en la simulación activa y en `/s/<id>`: qué
 * cambió, originales contra aprendidos, señales, monedas, parámetros, controles y la
 * lista de replays. Fuera de la activa, en pasado y sin acciones sobre el bot.
 */
export function AprendizajeScreen({ data, context, olderLog = null }: AprendizajeScreenProps) {
  const { data: live } = useLiveContext()
  const { session } = data
  const canAct = context.isActive
  const past = !canAct
  // Sin latido sólo importa en la activa: fuera de ella no hay acciones sobre el bot.
  const offline = canAct && live.offline
  const { now } = live
  // Un replay que corre, espera o no terminó no tiene aprendizaje que mostrar todavía.
  const unfinishedReplay = session.kind === 'replay' && session.status !== 'listo'
  const waiting = isReplayRunning(session) || data.queuedReplays.length > 0 || data.sessions.some((s) => isReplayRunning(s.session))

  return (
    <div className="column flex flex-col pt-6">
      <RefreshWhileRunning active={waiting} liveUpdates={canAct} />
      {unfinishedReplay ? (
        <ReplayState session={session} />
      ) : (
        <>
          <LearningHeadline
            progress={data.progress}
            lastChangeAt={data.log.entries[0]?.at ?? null}
            frozen={data.frozen.bySettings || data.frozen.byState}
            past={past}
            now={now}
          />
          {session.kind === 'replay' && <ReplaySummary session={session} />}
          <ChangesJournal log={data.log} older={olderLog} past={past} now={now} />
          <ShadowCompare
            shadow={data.shadow}
            startingPoint={data.startingPoint}
            session={session}
            canAct={canAct}
            past={past}
            offline={offline}
            closedTrades={data.progress.closedTrades}
            now={now}
          />
          <SignalsTable signals={data.signals} fromReplay={data.startingPoint !== null} />
          <CoinsConfidence coins={data.coins} past={past} now={now} />
          <ParamsCard
            params={data.params}
            startingParams={data.startingPoint?.params ?? null}
            // En un replay vale lo que se pidió al lanzarlo, no los ajustes de una sesión que no tiene.
            tuningEnabled={session.kind === 'replay' ? (session.replayParams?.paramTuning ?? false) : data.params.tuningEnabled}
            past={past}
            now={now}
          />
          {canAct && (
            <Controls sessionId={session.id} frozenByState={data.frozen.byState} closedTrades={data.progress.closedTrades} offline={offline} />
          )}
        </>
      )}
      <ReplaysList
        sessions={data.sessions}
        queued={data.queuedReplays}
        commands={live.commands}
        canAct={canAct}
        activeSessionId={canAct ? session.id : null}
        defaultCapital={session.capitalInicial}
        offline={offline}
        now={now}
      />
    </div>
  )
}
