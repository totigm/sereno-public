// Fiabilidad semanal de cada señal (spec §8.1, segunda vía), los domingos a las 00:30 UTC
// antes del ajuste de parámetros: correlación de Spearman entre lo que votó cada señal y el
// retorno a 4 h, sobre las decisiones de las últimas cuatro semanas. La misma ventana que
// usa el replay cuando simula este job.

import { applyReliability, reliability, type DecisionSample } from '@sereno/core/src/learning/reliability'
import { DAY_MS } from '@sereno/core/src/replay/clock'
import { RELIABILITY_WINDOW_MS } from '@sereno/core/src/replay/weekly-reliability'
import type { HookContext } from '../live/live-types'

// Devuelve cuántas decisiones entraron en la medición.
export async function reliabilityJob(ctx: Pick<HookContext, 'repos' | 'sessionId' | 'now' | 'settings' | 'updateLearning'>): Promise<number> {
  const samples: DecisionSample[] = []
  // De a un día: las decisiones traen sus señales y cuatro semanas son decenas de miles.
  for (let from = ctx.now - RELIABILITY_WINDOW_MS; from < ctx.now; from += DAY_MS) {
    for (const d of await ctx.repos.decisions.range(ctx.sessionId, from, Math.min(from + DAY_MS, ctx.now))) {
      if (d.forwardReturn4h !== null) samples.push({ signals: d.signals, forwardReturn4h: d.forwardReturn4h })
    }
  }
  const rho = reliability(samples)
  await ctx.updateLearning((current) => applyReliability(current, rho, ctx.settings.learning, ctx.now, { sampleSize: samples.length }))
  return samples.length
}
