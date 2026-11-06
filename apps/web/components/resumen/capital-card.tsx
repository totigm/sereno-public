'use client'

import clsx from 'clsx'
import { useState } from 'react'
import { capitalize } from '@sereno/core/src/journal/format'
import { CommandLine, progressOf } from '@/components/ajustes/command-line'
import { glue } from '@/components/ajustes/glue'
import { useCommand } from '@/components/ajustes/use-command'
import { Button } from '@/components/ui/button'
import { Confirm } from '@/components/ui/confirm'
import { releaseProtected } from '@/lib/actions/commands'
import { formatTimeBA } from '@/lib/format'
import type { CommandView } from '@/lib/live/types'
import type { CapitalCardView } from './capital-text'
import { Section } from './section'

export interface ReleaseAction {
  sessionId: string
  offline: boolean
  commands: readonly CommandView[]
  /** Qué pasa al volver a usarlo, con los números adentro (`releaseText`). */
  description: string
}

export interface CapitalCardProps {
  view: CapitalCardView
  /** Sin conexión y con abiertas: los montos salen de los precios de esa hora y van apagados. */
  pricesAt: number | null
  /** Estado 3 en la simulación activa (blindado y pausado solo): "Volver a usar el capital blindado". */
  release: ReleaseAction | null
  className?: string | undefined
}

const OFFLINE = 'El bot está sin conexión: lo vas a poder hacer cuando vuelva.'

const AMOUNT = /US\$ [\d.]+(?:,\d{2})?/

/** El primer monto de la frase va destacado, como en la Libreta: "A **US$ 452** de blindar…". */
function Title({ text }: { text: string }) {
  const match = AMOUNT.exec(text)
  if (!match) return glue(text)
  const end = match.index + match[0].length
  return (
    <>
      {glue(text.slice(0, match.index))}
      <strong className="font-semibold">{glue(match[0])}</strong>
      {glue(text.slice(end))}
    </>
  )
}

function Release({ sessionId, offline, commands, description }: ReleaseAction) {
  const [confirming, setConfirming] = useState(false)
  const release = useCommand((id) => releaseProtected({ id, sessionId }))
  const releasing = release.sentId !== null && ['sent', 'working'].includes(progressOf(commands.find((c) => c.id === release.sentId)))

  const send = async () => {
    if (await release.send('Enviado al bot: vuelve a usar el capital blindado.')) setConfirming(false)
  }

  return (
    <div className="flex flex-col items-start gap-1.5 border-t border-line pt-3">
      <Button variant="secondary" size="sm" disabled={offline || releasing} onClick={() => setConfirming(true)}>
        Volver a usar el capital blindado
      </Button>
      {offline && <p className="text-sm text-pretty text-muted">{OFFLINE}</p>}
      {release.sentId && (
        <CommandLine
          id={release.sentId}
          commands={commands}
          done="Listo: el capital blindado vuelve a operar."
          expired="El bot no lo tomó a tiempo: el capital sigue blindado."
          onCancel={release.cancel}
        />
      )}
      <Confirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={send}
        title="Volver a usar el capital blindado"
        description={glue(description)}
        confirmLabel="Volver a usar"
        pending={release.pending}
      />
    </div>
  )
}

/**
 * "Tu capital" (spec §7, §11.1): antes del blindaje, con la barra de lo que falta;
 * blindado; o blindado y pausado solo, con la acción para volver a usarlo. Debajo, en
 * los tres, la reinversión y el capital blindado en riesgo si las abiertas lo tocan.
 */
export function CapitalCard({ view, pricesAt, release, className }: CapitalCardProps) {
  const stale = pricesAt !== null
  const showBar = view.progress !== null && view.progress < 1
  const progress = view.progress ?? 0

  return (
    <Section title="Tu capital" className={className}>
      <div className="panel flex flex-col gap-3 p-4">
        <p className={clsx('text-[0.9375rem] leading-snug text-pretty', stale && 'text-muted')}>
          <Title text={view.title} />
        </p>
        {showBar && (
          <div
            role="progressbar"
            aria-label="Avance hacia el blindaje"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-2 overflow-hidden rounded-chip bg-ink/8"
          >
            {/* Sin avance no hay relleno: una franja verde mínima se leería como avance. El
                mínimo de 2% sólo hace visible un avance chico. */}
            {progress > 0 && (
              <div
                data-testid="capital-progress-fill"
                className={clsx('h-full rounded-chip', stale ? 'bg-muted' : 'bg-gain')}
                style={{ width: `${Math.max(2, progress * 100)}%` }}
              />
            )}
          </div>
        )}
        {view.detail && <p className="text-sm text-pretty text-muted">{glue(view.detail)}</p>}
        {stale && <p className="text-sm text-muted">{`Con los precios de las ${formatTimeBA(pricesAt)}.`}</p>}
        <dl className="flex flex-col gap-1 border-t border-line pt-3 text-sm">
          <div className="text-pretty">
            <dt className="inline text-muted">Reinversión: </dt>
            <dd className="inline">{glue(view.reinvest)}</dd>
          </div>
          {view.atRisk && (
            <div>
              <dt className="sr-only">Aviso:</dt>
              <dd className="flex items-start gap-2 font-medium text-pretty text-loss">
                <span aria-hidden className="mt-[0.4375rem] size-1.5 shrink-0 rounded-full bg-loss" />
                {glue(capitalize(view.atRisk))}
              </dd>
            </div>
          )}
        </dl>
        {release && <Release {...release} />}
      </div>
    </Section>
  )
}
