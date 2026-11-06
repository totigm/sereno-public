'use client'

import { useId, type ReactNode } from 'react'
import { Sheet } from '@/components/ui/sheet'
import { formatTimeBA } from '@/lib/format'
import type { OpenPositionView } from '@/lib/live/types'
import type { CoinDetail, CoinInfo } from '@/lib/queries/monedas'
import { useHydrated } from '@/lib/use-hydrated'
import { CoinChart } from './coin-chart'
import { CoinSummary } from './coin-summary'
import { confidenceSentence, decisionSentence, leanSentence, statsSentence } from './phrases'
import { SignalBars } from './signal-bars'
import type { TileModel } from './tile-model'

export interface CoinSheetProps {
  /** La baldosa de `?moneda=`; sin ella la hoja está cerrada. */
  tile: TileModel | undefined
  /** Decisión, pesos, confianza y estadísticas que trajo el servidor. */
  info: CoinInfo | undefined
  detail: CoinDetail | null
  position: OpenPositionView | undefined
  theta: number
  now: number
  past: boolean
  stale: boolean
  marksAt: number | null
  base: string
  /** Fijar y excluir; sólo en la simulación activa. */
  footer: ReactNode
  onClose: () => void
}

/**
 * La hoja de una moneda (spec §11.1): estado o abierta, gráfico, el puntaje desglosado
 * por señal, lo aprendido y, al pie, fijar o excluir.
 */
export function CoinSheet({ tile, footer, onClose, ...body }: CoinSheetProps) {
  // La hoja es un portal que el servidor no dibuja: con `?moneda=` en el enlace se abre al hidratar.
  const hydrated = useHydrated()
  return (
    <Sheet open={hydrated && tile !== undefined} onClose={onClose} title={tile?.name ?? ''} {...(footer ? { footer } : {})}>
      {tile && <CoinSheetBody tile={tile} {...body} />}
    </Sheet>
  )
}

type BodyProps = Omit<CoinSheetProps, 'tile' | 'footer' | 'onClose'> & { tile: TileModel }

function CoinSheetBody({ tile, info, detail, position, theta, now, past, stale, marksAt, base }: BodyProps) {
  const signalsId = useId()
  const learnedId = useId()
  const decision = info?.decision ?? null

  return (
    <div className="flex flex-col gap-7 pt-1">
      <CoinSummary tile={tile} position={position} now={now} past={past} stale={stale} marksAt={marksAt} base={base} />
      <CoinChart symbol={tile.symbol} name={tile.name} detail={detail} past={past} stale={stale} marksAt={marksAt} />

      <section aria-labelledby={signalsId} className="flex flex-col gap-3">
        <h3 id={signalsId} className="text-[0.9375rem] font-semibold">
          Señales del último ciclo
        </h3>
        {decision === null || info === undefined ? (
          <p className="text-[0.9375rem] text-muted">{past ? `No llegué a evaluar ${tile.name}.` : `Todavía no evalué ${tile.name}.`}</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="flex gap-2 text-[0.9375rem]">
                <time dateTime={new Date(decision.at).toISOString()} className="shrink-0 text-muted tabular-nums">
                  {formatTimeBA(decision.at)}
                </time>
                <span className="min-w-0 text-pretty">{decisionSentence(tile.symbol, decision, past || stale)}</span>
              </p>
              <p className="text-[0.8125rem] text-pretty text-muted">{leanSentence(decision.Sprime, theta, past || stale)}</p>
            </div>
            <SignalBars signals={decision.signals} weights={info.weights} labelledBy={signalsId} />
          </>
        )}
      </section>

      {info && (
        <section aria-labelledby={learnedId} className="flex flex-col gap-2">
          <h3 id={learnedId} className="text-[0.9375rem] font-semibold">
            Lo aprendido
          </h3>
          <p className="text-[0.9375rem] text-pretty">{confidenceSentence(info, past)}</p>
          <p className="text-[0.9375rem] text-pretty text-muted">{statsSentence(info.stats, info.name, past)}</p>
        </section>
      )}
    </div>
  )
}
