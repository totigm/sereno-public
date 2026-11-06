import type { LearningState } from '@sereno/core'
import { DEFAULT_SETTINGS, formatNumber } from '@/lib/format'
import type { AprendizajeData } from '@/lib/queries/aprendizaje'
import { JournalEntry } from './journal-entry'
import { formatPlainR, journalWhen, whenPhrase } from './labels'
import { Section } from './section'

type Params = LearningState['params']

export interface ParamsCardProps {
  params: AprendizajeData['params']
  /** Los parámetros con que arrancó, si vino de un replay ("punto de partida"). */
  startingParams: Params | null
  /** Si el ajuste semanal corre (en un replay, lo que se pidió al lanzarlo). */
  tuningEnabled: boolean
  past: boolean
  now: number
}

const FACTORY: Omit<Params, 'since'> = {
  theta: DEFAULT_SETTINGS.entry.theta,
  k: DEFAULT_SETTINGS.exits.k,
  tpR: DEFAULT_SETTINGS.exits.tpR,
  trailingR: DEFAULT_SETTINGS.exits.trailingR,
}

const ITEMS: { key: keyof typeof FACTORY; label: string; format: (v: number) => string }[] = [
  { key: 'theta', label: 'Umbral de entrada', format: (v) => formatNumber(v, 2) },
  { key: 'k', label: 'Distancia del stop', format: (v) => `${formatNumber(v, 1)} × ATR` },
  { key: 'tpR', label: 'Take profit', format: formatPlainR },
  { key: 'trailingR', label: 'Trailing', format: formatPlainR },
]

function summary({ params, startingParams, tuningEnabled, past, now }: ParamsCardProps): string {
  const origin = startingParams ? 'los del punto de partida' : 'los de fábrica'
  const since = params.lastChangeAt === null ? `Son ${origin}: ${past ? 'no cambiaron' : 'todavía no cambiaron'}.` : `Vigentes desde ${whenPhrase(params.lastChangeAt, now)}.`
  if (past) return `${since}${tuningEnabled ? '' : ' El ajuste semanal estuvo apagado.'}`
  // Domingo 00:30 UTC (spec §8.3) es el sábado a las 21:30 en Buenos Aires.
  return `${since} ${
    tuningEnabled
      ? 'Los reviso cada sábado a las 21:30 con los últimos 60 días y cambian sólo si otra combinación rinde claramente mejor.'
      : 'El ajuste semanal está apagado en Ajustes.'
  }`
}

/** Parámetros vigentes (spec §8.3): con la fecha del último cambio y lo que se probó y no se adoptó. */
export function ParamsCard(props: ParamsCardProps) {
  const { params, startingParams, now } = props
  const base = startingParams ?? FACTORY
  return (
    <Section title="Parámetros" description={summary(props)}>
      <dl className="panel grid grid-cols-2 gap-x-4 gap-y-4 p-4 desktop:grid-cols-4">
        {ITEMS.map(({ key, label, format }) => {
          const value = params.current[key]
          const changed = value !== base[key]
          return (
            <div key={key} className="flex flex-col gap-0.5">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="text-lg font-medium tabular-nums">{format(value)}</dd>
              {changed && (
                <dd className="text-xs text-muted tabular-nums">
                  {startingParams ? 'al partir' : 'de fábrica'} {format(base[key])}
                </dd>
              )}
            </div>
          )
        })}
      </dl>
      {params.rejected.length > 0 && (
        <div className="mt-2">
          <h3 className="text-sm font-semibold">Lo que probé y no adopté</h3>
          <ol className="mt-1 border-b border-line">
            {params.rejected.map((entry) => (
              <JournalEntry key={entry.id} at={entry.at} when={journalWhen(entry.at, now)}>
                {entry.text}
              </JournalEntry>
            ))}
          </ol>
        </div>
      )}
    </Section>
  )
}
