'use client'

import { useState, type FormEvent } from 'react'
import type { LearningOrigin, Settings } from '@sereno/shared'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { LivePreview, shieldPreview } from '@/components/ajustes/live-preview'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Segment } from '@/components/ui/segment'
import { createSession } from '@/lib/actions/session'
import { parseCapital } from '@/lib/amount'
import { formatPct } from '@/lib/format'
import type { FirstRunData } from '@/lib/queries/resumen'
import { capitalInput, originOptions, protectOptions } from './first-run-model'
import { HEADLINE_TYPE } from './headline'
import { RadioList } from './radio-list'

type Mode = Settings['mode']

const MODES: { value: Mode; title: string; description: string }[] = [
  {
    value: 'auto',
    title: 'El bot decide todo',
    description: `Tamaño, apalancamiento y salidas salen del riesgo: un stop tocado pierde como máximo el ${formatPct(DEFAULT_SETTINGS.risk.riskPerTrade, 0, false)} del capital.`,
  },
  { value: 'custom', title: 'Yo fijo tamaño y salidas', description: 'Elegís margen, apalancamiento, TP y SL en Ajustes. Los cortes de la cuenta siguen valiendo.' },
]

const CAPITAL_ERROR = 'Escribí un monto en dólares, por ejemplo 1.000.'
const UNSENT = 'No pude crear la simulación. Revisá la conexión y probá de nuevo.'

/**
 * El primer uso (spec §11.1): dos pasos —capital y blindaje con la frase viva; quién
 * decide— y un tercero para elegir de dónde arranca el aprendizaje sólo si hay replays
 * con aprendizaje. "Empezar a simular" crea la simulación y la página pasa a Resumen.
 */
export function ResumenFirstRun({ data }: { data: FirstRunData }) {
  const { defaults, learningSources } = data
  const origins = originOptions(learningSources)
  const steps = origins.length > 0 ? 3 : 2
  const [step, setStep] = useState(1)
  const [capitalText, setCapitalText] = useState(capitalInput(defaults.capital))
  const [capitalError, setCapitalError] = useState<string | null>(null)
  const [protectPct, setProtectPct] = useState(defaults.protectPct)
  const [mode, setMode] = useState<Mode>(defaults.mode)
  const [origin, setOrigin] = useState<LearningOrigin>('zero')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const capital = parseCapital(capitalText)
  const preview = shieldPreview(protectPct, { capitalInicial: capital ?? defaults.capital, baseBlindaje: capital ?? defaults.capital })

  const submit = async () => {
    if (capital === null) {
      setStep(1)
      setCapitalError(CAPITAL_ERROR)
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = await createSession({ capital, protectPct, mode, learningOrigin: origin })
      // Bien: la acción refresca la página, que ya trae la simulación nueva.
      if (!result.ok) setError(result.message)
    } catch {
      setError(UNSENT)
    } finally {
      setPending(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (step === 1 && capital === null) {
      setCapitalError(CAPITAL_ERROR)
      return
    }
    if (step < steps) setStep(step + 1)
    else void submit()
  }

  return (
    <div className="column flex flex-col pt-6">
      <header className="flex flex-col gap-2.5">
        <h1 className={HEADLINE_TYPE}>Armemos la simulación.</h1>
        <p className="max-w-[34rem] text-[0.9375rem] text-pretty text-muted">
          El bot opera con plata de mentira y precios reales de Binance, y te cuenta qué hizo y por qué. Todo se puede cambiar después en
          Ajustes.
        </p>
      </header>

      <form onSubmit={onSubmit} noValidate aria-label="Crear la simulación" className="panel mt-6 flex flex-col gap-5 p-5">
        <p className="text-sm font-medium text-muted">{`Paso ${step} de ${steps}`}</p>

        {step === 1 && (
          <>
            <Field
              label="Capital inicial"
              prefix="US$"
              inputMode="decimal"
              autoComplete="off"
              value={capitalText}
              onChange={(event) => {
                setCapitalText(event.target.value)
                setCapitalError(null)
              }}
              {...(capitalError ? { error: capitalError } : { hint: 'Es plata simulada: elegí con cuánto querés ver cómo le va.' })}
            />
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                Blindaje del capital inicial
              </p>
              <Segment
                options={protectOptions(defaults.protectPct)}
                value={String(protectPct)}
                onChange={(value) => setProtectPct(Number(value))}
                label="Blindaje del capital inicial"
                className="self-start"
              />
              <LivePreview text={preview} />
            </div>
          </>
        )}

        {step === 2 && <RadioList legend="¿Quién decide el tamaño y las salidas?" name="modo" options={MODES} value={mode} onChange={setMode} />}

        {step === 3 && <RadioList legend="¿Arranca con lo aprendido?" name="origen" options={origins} value={origin} onChange={setOrigin} />}

        <div className="flex flex-col gap-2 desktop:flex-row-reverse desktop:justify-start">
          <Button type="submit" variant="primary" pending={pending} className="desktop:min-w-44">
            {step < steps ? 'Seguir' : 'Empezar a simular'}
          </Button>
          {step > 1 && (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setStep(step - 1)}>
              Volver
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-pretty text-loss">
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
