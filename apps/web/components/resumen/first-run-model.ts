import type { LearningOrigin } from '@sereno/shared'
import { formatDateBA, formatNumber } from '@/lib/format'
import type { LearningSources } from '@/lib/queries/sql/sessions'

// Lo que decide el formulario de primer uso (spec §11.1): el capital como valor del
// campo (se lee con `parseCapital`), las opciones del blindaje y de dónde arranca el aprendizaje.

/** El capital como valor inicial del campo: "1.000". */
export function capitalInput(n: number): string {
  return formatNumber(n, Number.isInteger(n) ? 0 : 2)
}

export interface ProtectOption {
  value: string
  label: string
  pct: number
}

/** Las opciones del blindaje, con la de los ajustes por defecto aunque no sea redonda. */
export function protectOptions(defaultPct: number): ProtectOption[] {
  const pcts = [...new Set([0, 0.5, defaultPct, 1])].sort((a, b) => a - b)
  return pcts.map((pct) => ({ value: String(pct), label: pct === 0 ? 'Sin blindaje' : `${formatNumber(pct * 100, 0)}%`, pct }))
}

export interface OriginOption {
  value: LearningOrigin
  title: string
  description: string
}

function replayTitle(name: string, endedAt: number | null): string {
  return endedAt === null ? `Lo aprendido en ${name}` : `Lo aprendido en ${name} (terminó el ${formatDateBA(endedAt)})`
}

/** Paso 3: desde cero, o con lo aprendido antes. Vacío si no hay replays con aprendizaje (no hay paso 3). */
export function originOptions(sources: LearningSources): OriginOption[] {
  if (sources.replays.length === 0) return []
  return [
    { value: 'zero', title: 'Desde cero', description: 'Empieza con los valores por defecto y aprende de sus propias operaciones.' },
    ...(sources.continued
      ? [{ value: 'continued' as const, title: 'Lo aprendido en la simulación anterior', description: 'Sigue con los pesos y el umbral que había ajustado.' }]
      : []),
    ...sources.replays.map((r) => ({
      value: `replay:${r.id}` as const,
      title: replayTitle(r.name, r.endedAt),
      description: 'Arranca con lo que aprendió en ese período del pasado.',
    })),
  ]
}
