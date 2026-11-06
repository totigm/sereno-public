'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { REAL_LOSS_CAP_DEFAULT } from '@sereno/shared'
import { formatUsdRound } from '@sereno/core/src/journal/format'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useToast } from '@/components/ui/toast'
import { createRealSession } from '@/lib/actions/real'
import { parseCapital } from '@/lib/amount'
import type { RealPanel } from '@/lib/queries/real'
import { LOSS_CAP_NOTICE } from '@/lib/real-copy'
import { MissingList } from './missing-list'
import { RowFrame } from './setting-row'
import { TypedConfirm } from './typed-confirm'
import { parseInput, toInput } from './units'

const MIN_CAPITAL = 5
const MAX_CAPITAL = 100_000
const UNSENT = 'No pude crear la sesión. Revisá la conexión y probá de nuevo.'

/** Adonde lleva "Empezar otra" desde la sesión real que tocó el tope. */
export const REAL_CREATE_ID = 'empezar-otra'

function capitalError(text: string, capital: number | null, wallet: number | null): string | null {
  if (text.trim() === '') return null
  if (capital === null || capital < MIN_CAPITAL || capital > MAX_CAPITAL) return 'Entre US$ 5 y US$ 100.000.'
  if (wallet !== null && capital > wallet) return `En la billetera de futuros hay ${formatUsdRound(wallet)}: no alcanza.`
  return null
}

function lossCapError(lossCap: number | null): string | null {
  return lossCap === null || lossCap < 0.1 || lossCap > 1 ? 'Entre 10% y 100%.' : null
}

/**
 * Crear la sesión con plata real (spec real §Cómo se prende, paso 4): capital asignado,
 * tope de pérdida y la confirmación escribiendo el monto. Mientras falte algo el botón
 * queda apagado y la lista dice qué.
 */
export function RealCreate({ panel, replaces }: { panel: RealPanel; replaces: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [capitalText, setCapitalText] = useState('')
  const [lossCapText, setLossCapText] = useState(toInput(REAL_LOSS_CAP_DEFAULT, 'pct'))
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  const wallet = panel.readiness?.walletAvailable ?? null
  const capital = parseCapital(capitalText)
  const lossCap = parseInput(lossCapText, 'pct')
  const capitalProblem = capitalError(capitalText, capital, wallet)
  const lossCapProblem = lossCapError(lossCap)
  const ready = panel.canCreate.ok && capital !== null && capitalProblem === null && lossCap !== null && lossCapProblem === null

  const create = async (typed: string) => {
    if (capital === null || lossCap === null) return
    setPending(true)
    try {
      const result = await createRealSession({ capital, lossCap, confirmation: typed })
      if (result.ok) {
        setConfirming(false)
        router.push(`/s/${result.sessionId}/ajustes`)
      } else {
        toast({ message: result.message })
      }
    } catch {
      toast({ message: UNSENT })
    } finally {
      setPending(false)
    }
  }

  const floorHint =
    capital !== null && lossCap !== null && lossCapProblem === null
      ? `Si pierde ${formatUsdRound(capital * lossCap)}, cierro todo y la apago.`
      : 'Si pierde eso del capital, cierro todo y la apago.'

  return (
    <RowFrame>
      <div id={REAL_CREATE_ID} className="flex scroll-mt-24 flex-col gap-4 py-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Capital asignado"
            prefix="US$"
            inputMode="decimal"
            autoComplete="off"
            placeholder="50"
            value={capitalText}
            onChange={(event) => setCapitalText(event.target.value)}
            error={capitalProblem ?? undefined}
            hint={wallet === null ? 'El bot opera como si tu cuenta tuviera sólo esto.' : `Hay ${formatUsdRound(wallet)} disponibles en la billetera de futuros.`}
          />
          <Field
            label="Tope de pérdida"
            suffix="%"
            inputMode="decimal"
            autoComplete="off"
            value={lossCapText}
            onChange={(event) => setLossCapText(event.target.value)}
            error={lossCapProblem ?? undefined}
            hint={floorHint}
          />
        </div>
        <p className="text-sm text-muted text-pretty">{LOSS_CAP_NOTICE}</p>
        {replaces && <p className="text-sm text-muted text-pretty">La sesión con plata real anterior queda guardada, con su historia, y se puede volver a ver.</p>}
        {!panel.canCreate.ok && panel.canCreate.missing.length > 0 && <MissingList items={panel.canCreate.missing} />}
        <Button variant="danger" disabled={!ready} onClick={() => setConfirming(true)} className="self-start">
          Empezar con plata real
        </Button>
      </div>
      {capital !== null && (
        <TypedConfirm
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={create}
          title="Empezar con plata real"
          capital={capital}
          confirmLabel="Empezar con plata real"
          pending={pending}
        />
      )}
    </RowFrame>
  )
}
