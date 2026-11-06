'use client'

import Link from 'next/link'
import { useId } from 'react'
import { SHADOW_MIN_TRADES, SHADOW_WARN_PP, type ShadowComparison } from '@sereno/core/src/learning/shadow'
import { contextBandLabel } from '@/components/nav/session-labels'
import { formatNumber, formatPct, formatSigned } from '@/lib/format'
import type { AprendizajeData } from '@/lib/queries/aprendizaje'
import type { SessionView } from '@/lib/queries/session'
import { formatSumR, whenPhrase } from './labels'
import { OfflineNote } from './offline-note'
import { ResetLearning } from './reset-learning'
import { Section } from './section'
import { ShadowChart } from './shadow-chart'

/** Ventana de la comparación (spec §8): la de `getAprendizajeData`. */
const WINDOW_DAYS = 14

export interface ShadowCompareProps {
  shadow: AprendizajeData['shadow']
  startingPoint: AprendizajeData['startingPoint']
  session: SessionView
  /** Simulación activa: el aviso ofrece reiniciar el aprendizaje. */
  canAct: boolean
  /** Replay o archivada: copy en pasado. */
  past: boolean
  /** Bot sin conexión: reiniciar queda apagado, con la explicación. */
  offline: boolean
  /** Trades cerrados de los que aprendió (para la confirmación de reinicio). */
  closedTrades?: number
  now: number
}

/** "en los últimos 14 días", "desde el 16 de octubre": el tramo que mide la comparación. */
function windowPhrase(session: SessionView, comparison: ShadowComparison, past: boolean, now: number): string {
  const startedInside = session.period.from > comparison.from
  if (past) return startedInside ? 'desde que empezó' : `en sus últimos ${WINDOW_DAYS} días`
  return startedInside ? `desde ${whenPhrase(session.period.from, now)}` : `en los últimos ${WINDOW_DAYS} días`
}

/**
 * Originales contra aprendidos (spec §8, "Sombra"; §11.1.4): la diferencia en puntos
 * porcentuales de I₀ como cifra principal, retorno y suma de R de cada cartera, las dos
 * curvas, y el aviso si los originales vienen ganando por más de 3 puntos.
 */
export function ShadowCompare({ shadow, startingPoint, session, canAct, past, offline, closedTrades = 0, now }: ShadowCompareProps) {
  return (
    <Section
      title="Originales contra aprendidos"
      description="Los originales deciden en paralelo con los pesos y parámetros de fábrica, con las mismas reglas de capital."
    >
      {shadow === null ? (
        <p className="border-t border-line pt-3 text-muted">
          {past ? 'No quedó curva de los originales para comparar.' : 'Todavía no hay curva de los originales para comparar.'}
        </p>
      ) : (
        <ComparisonPanel shadow={shadow} session={session} canAct={canAct} past={past} offline={offline} closedTrades={closedTrades} now={now} />
      )}
      {startingPoint && (
        <p className="text-sm text-pretty text-muted">
          Punto de partida: {past ? 'arrancó' : 'arranqué'} con lo aprendido en{' '}
          <Link href={`/s/${startingPoint.replay.id}/aprendizaje`} className="font-medium text-ink underline underline-offset-4">
            {startingPoint.replay.name}
          </Link>{' '}
          ({contextBandLabel(startingPoint.replay)}). En las señales, la marca de cada peso es ese punto de partida.
        </p>
      )}
    </Section>
  )
}

interface ComparisonPanelProps {
  shadow: NonNullable<AprendizajeData['shadow']>
  session: SessionView
  canAct: boolean
  past: boolean
  offline: boolean
  closedTrades: number
  now: number
}

/**
 * La cifra va siempre del lado de los originales, como la mide `gapPp` y como la dice
 * el aviso: "+3,2 puntos" es que van 3,2 puntos de I₀ por encima de lo aprendido, y la
 * frase de abajo lo dice con palabras para que el signo no se lea como una ganancia.
 */
function gapCopy(gapPp: number, past: boolean, when: string): { figure: string; caption: string } {
  if (formatNumber(Math.abs(gapPp), 1) === formatNumber(0, 1)) {
    return { figure: `${formatNumber(0, 1)} puntos`, caption: `Lo aprendido y los originales ${past ? 'fueron' : 'van'} parejos ${when}.` }
  }
  const side = gapPp > 0 ? 'por encima' : 'por debajo'
  return {
    figure: `${formatSigned(gapPp, 1)} puntos`,
    caption: `Los originales ${past ? 'quedaron' : 'van'} ${side} de lo aprendido ${when}, sobre el capital inicial.`,
  }
}

function ComparisonPanel({ shadow, session, canAct, past, offline, closedTrades, now }: ComparisonPanelProps) {
  const { comparison: c, curve } = shadow
  const { figure, caption } = gapCopy(c.gapPp, past, windowPhrase(session, c, past, now))
  const windowFrom = session.period.from > c.from ? null : c.from
  const offlineNoteId = useId()

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div>
        <p className="text-[2rem] leading-tight font-medium tracking-[-0.02em] tabular-nums">{figure}</p>
        <p className="text-sm text-pretty text-muted">{caption}</p>
      </div>

      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="pb-1 text-left font-medium">
              <span className="sr-only">Cartera</span>
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Retorno
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Trades
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Suma de R
            </th>
          </tr>
        </thead>
        <tbody>
          <PortfolioRow tone="ink" name="Lo aprendido" pp={c.learnedPp} trades={c.tradesLearned} sumR={c.sumRLearned} />
          <PortfolioRow tone="muted" name="Originales" pp={c.shadowPp} trades={c.tradesShadow} sumR={c.sumRShadow} />
        </tbody>
      </table>

      <ShadowChart points={curve.points} windowFrom={windowFrom} windowLabel={`${WINDOW_DAYS} días`} now={now} />

      {!c.enoughTrades && (
        <p className="text-sm text-pretty text-muted">
          Con menos de {SHADOW_MIN_TRADES} trades en cada cartera la diferencia todavía no dice mucho: {past ? 'quedaron' : 'van'}{' '}
          {c.tradesLearned} y {c.tradesShadow}.
        </p>
      )}
      {c.warn && (
        <div className="flex flex-col gap-3 rounded-control bg-loss-soft px-4 py-3 text-sm desktop:flex-row desktop:items-center desktop:justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-pretty">
              {past
                ? `Los originales rindieron más de ${SHADOW_WARN_PP} puntos por encima de lo aprendido.`
                : `Los originales vienen rindiendo más de ${SHADOW_WARN_PP} puntos por encima de lo aprendido. Te sugiero reiniciar el aprendizaje; no lo hago solo.`}
            </p>
            {canAct && offline && <OfflineNote id={offlineNoteId} verb="reiniciar" tone="ink" />}
          </div>
          {canAct && (
            <ResetLearning
              sessionId={session.id}
              closedTrades={closedTrades}
              label="Reiniciar aprendizaje"
              offline={offline}
              offlineNoteId={offlineNoteId}
              className="shrink-0"
            />
          )}
        </div>
      )}
    </div>
  )
}

function PortfolioRow({ tone, name, pp, trades, sumR }: { tone: 'ink' | 'muted'; name: string; pp: number; trades: number; sumR: number }) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-1.5 text-left font-medium">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className={`h-0.5 w-4 rounded-chip ${tone === 'ink' ? 'bg-ink' : 'bg-muted'}`} />
          {name}
        </span>
      </th>
      <td className="py-1.5 text-right">{formatPct(pp / 100)}</td>
      <td className="py-1.5 text-right">{trades}</td>
      <td className="py-1.5 text-right">{formatSumR(sumR)}</td>
    </tr>
  )
}
