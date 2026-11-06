'use client'

import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Segment } from '@/components/ui/segment'
import { Sheet } from '@/components/ui/sheet'
import { Toggle } from '@/components/ui/toggle'
import { useToast } from '@/components/ui/toast'
import { runReplay } from '@/lib/actions/commands'
import { formatNumber } from '@/lib/format'
import { shortDate } from './labels'

const DAY_MS = 86_400_000
/** Spec §9: por defecto 90 días; `CommandSchema` acepta de 1 a 365. */
const DEFAULT_REPLAY_DAYS = 90
const MAX_DAYS = 365
const MAX_CAPITAL = 1e9

type Learning = 'zero' | 'current'

const LEARNING_OPTIONS = [
  { value: 'zero', label: 'Desde cero' },
  { value: 'current', label: 'El vigente' },
] as const

const LEARNING_HINT: Record<Learning, string> = {
  zero: 'Arranca con los pesos y parámetros de fábrica.',
  current: 'Arranca con lo que aprendió esta simulación hasta ahora.',
}

const OFFLINE_QUEUE_TEXT = 'El bot está sin conexión: el replay queda en cola y arranca cuando vuelva.'

export interface RunReplaySheetProps {
  open: boolean
  onClose: () => void
  /** La simulación activa: el replay sale de ella (y toma su aprendizaje si se pide). */
  sessionId: string
  defaultCapital: number
  offline: boolean
  now: number
}

function parseDays(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const days = Number(text.trim())
  return days >= 1 && days <= MAX_DAYS ? days : null
}

/** "1.000", "1000", "1.500,50" o "US$ 2.000" → número; null si no es un monto positivo. */
function parseAmount(text: string): number | null {
  let clean = text.replace(/US\$/i, '').replace(/\s/g, '')
  if (clean.includes(',')) clean = clean.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(clean)) clean = clean.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(clean)) return null
  const value = Number(clean)
  return value > 0 && value <= MAX_CAPITAL ? value : null
}

function capitalText(capital: number): string {
  return formatNumber(capital, Number.isInteger(capital) ? 0 : 2)
}

/**
 * "Correr un replay" (spec §9, §11.1.4): días, capital, aprendizaje de partida y ajuste
 * de parámetros (apagado por defecto). Sin conexión, lo dice y lo encola igual: el bot
 * lo toma cuando vuelve.
 */
export function RunReplaySheet({ open, onClose, ...form }: RunReplaySheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Correr un replay">
      <RunReplayForm onDone={onClose} {...form} />
    </Sheet>
  )
}

function RunReplayForm({ onDone, sessionId, defaultCapital, offline, now }: Omit<RunReplaySheetProps, 'open' | 'onClose'> & { onDone: () => void }) {
  const toast = useToast()
  const [daysText, setDaysText] = useState(String(DEFAULT_REPLAY_DAYS))
  const [capital, setCapital] = useState(capitalText(defaultCapital))
  const [learning, setLearning] = useState<Learning>('zero')
  const [tuning, setTuning] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const days = parseDays(daysText)
  const amount = parseAmount(capital)
  const daysError = submitted && days === null ? `Elegí entre 1 y ${MAX_DAYS} días.` : undefined
  const capitalError = submitted && amount === null ? 'Poné un capital mayor a cero, por ejemplo 1.000.' : undefined

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (days === null || amount === null) return
    setPending(true)
    setFailure(null)
    const result = await runReplay({ id: crypto.randomUUID(), sessionId, days, capital: amount, learningOrigin: learning, paramTuning: tuning })
    setPending(false)
    if (!result.ok) {
      setFailure(result.message)
      return
    }
    onDone()
    toast({ message: offline ? 'Replay en cola: arranca cuando el bot vuelva.' : 'Pedí el replay: arranca en unos segundos.' })
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5">
      <p className="text-pretty text-muted">Simula la estrategia sobre el mercado de los últimos días, con el mismo motor y las mismas reglas. Esta simulación sigue como está.</p>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Días"
          inputMode="numeric"
          autoComplete="off"
          value={daysText}
          onChange={(event) => setDaysText(event.target.value)}
          error={daysError}
          hint={days === null ? `De 1 a ${MAX_DAYS}.` : `Del ${shortDate(now - days * DAY_MS, now)} al ${shortDate(now, now)}.`}
        />
        <Field
          label="Capital inicial"
          inputMode="decimal"
          autoComplete="off"
          prefix="US$"
          value={capital}
          onChange={(event) => setCapital(event.target.value)}
          error={capitalError}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        {/* El grupo ya se anuncia como "Aprendizaje": el rótulo visible no se lee dos veces. */}
        <span aria-hidden className="text-sm font-medium">
          Aprendizaje
        </span>
        <Segment label="Aprendizaje" options={LEARNING_OPTIONS} value={learning} onChange={setLearning} className="self-start" />
        <p className="text-sm text-muted">{LEARNING_HINT[learning]}</p>
      </div>

      <Toggle
        checked={tuning}
        onChange={setTuning}
        label="Ajustar parámetros cada semana"
        description="Prueba las 135 combinaciones cada domingo simulado: tarda bastante más."
      />

      {offline && (
        <p role="status" className="flex items-start gap-3 rounded-panel border border-line px-4 py-3 text-sm">
          <span aria-hidden className="mt-[0.4375rem] size-1.5 shrink-0 rounded-full bg-muted" />
          <span className="text-pretty">{OFFLINE_QUEUE_TEXT}</span>
        </p>
      )}
      {failure && (
        <p role="alert" className="rounded-panel bg-loss-soft px-4 py-3 text-sm">
          {failure}
        </p>
      )}

      <Button type="submit" variant="primary" pending={pending} className="w-full">
        Correr el replay
      </Button>
    </form>
  )
}
