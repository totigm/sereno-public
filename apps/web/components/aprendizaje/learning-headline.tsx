import { Chip } from '@/components/ui/chip'
import type { AprendizajeData } from '@/lib/queries/aprendizaje'
import { plural, whenPhrase } from './labels'

export interface LearningHeadlineProps {
  progress: AprendizajeData['progress']
  /** Cuándo fue el último cambio del diario; null si no hubo ninguno. */
  lastChangeAt: number | null
  frozen: boolean
  /** Replay o simulación archivada: copy en pasado. */
  past: boolean
  now: number
}

interface HeadlineText {
  title: string
  detail: string
}

function headlineText({ progress, lastChangeAt, past, now }: LearningHeadlineProps): HeadlineText {
  const { closedTrades: n, minTrades: min } = progress
  if (n === 0 && lastChangeAt === null) {
    return {
      title: 'Todavía no aprendí nada: necesito trades cerrados.',
      detail: past ? 'No llegó a cerrar ningún trade.' : `Empiezo a mover los pesos de las señales a los ${min} trades cerrados.`,
    }
  }
  if (progress.collecting) {
    return past
      ? {
          title: `Junté ${n} de los ${min} trades cerrados que necesito para mover los pesos.`,
          detail: 'La confianza en cada moneda sí se movió con cada trade.',
        }
      : {
          title: `Estoy juntando datos: ${n} de ${min} trades cerrados.`,
          detail: `Hasta los ${min} no toco los pesos de las señales; la confianza en cada moneda ya se mueve con cada trade.`,
        }
  }
  return {
    title: `Aprendí de ${plural(n, 'trade cerrado', 'trades cerrados')}.`,
    detail: lastChangeAt !== null ? `El último cambio fue ${whenPhrase(lastChangeAt, now)}.` : past ? 'No llegó a cambiar nada.' : 'Todavía no cambié nada.',
  }
}

/** El titular de Aprendizaje: en qué etapa está el aprendizaje, con el número adentro. */
export function LearningHeadline(props: LearningHeadlineProps) {
  const { title, detail } = headlineText(props)
  const frozen = props.frozen && !props.past
  return (
    <header className="flex flex-col gap-2">
      <h1 className="headline max-w-[34rem]">{title}</h1>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        {frozen && <Chip tone="info">Congelado</Chip>}
        <span className="text-pretty">{frozen ? 'No cambio pesos, confianza ni parámetros hasta que lo descongeles.' : detail}</span>
      </p>
    </header>
  )
}
