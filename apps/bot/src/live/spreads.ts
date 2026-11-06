// Medio spread observado del libro (spec §6). Cada 5 min se lee el bookTicker de las
// monedas que se siguen; una vez por día, la mediana de las últimas 24 h queda en
// `symbols.observedSpread`, que los replays usan en lugar del supuesto y que en vivo es el
// medio spread del simulador (los contratos del simulador se fijan al crearlo: no se puede
// leer el libro en el momento de cada orden). Las muestras viven en memoria: después de un
// reinicio hacen falta otras 24 h y mientras tanto queda el valor anterior.

import type { Repos } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import { bookHalfSpread } from '../binance/symbol-info'
import { isSymbolScoped } from '../jobs/errors'
import { DAY_MS, MINUTE_MS } from './scheduler'

export const SPREAD_SAMPLE_MS = 5 * MINUTE_MS
const WINDOW_MS = DAY_MS

interface Sample {
  at: number
  halfSpread: number
}

export class SpreadSampler {
  private readonly samples = new Map<string, Sample[]>()

  add(symbol: string, at: number, halfSpread: number): void {
    const kept = (this.samples.get(symbol) ?? []).filter((s) => s.at > at - WINDOW_MS - SPREAD_SAMPLE_MS)
    this.samples.set(symbol, [...kept, { at, halfSpread }])
  }

  // La mediana de las últimas 24 h; null hasta que las muestras cubran el día.
  median(symbol: string, now: number): number | null {
    const all = this.samples.get(symbol) ?? []
    const oldest = all[0]
    if (!oldest || oldest.at > now - WINDOW_MS) return null
    const values = all.filter((s) => s.at > now - WINDOW_MS).map((s) => s.halfSpread)
    return median(values)
  }
}

export async function sampleSpreads(rest: Pick<BinanceRest, 'bookTicker'>, sampler: SpreadSampler, symbols: readonly string[], at: number): Promise<void> {
  for (const symbol of symbols) {
    try {
      const halfSpread = bookHalfSpread(await rest.bookTicker(symbol))
      if (halfSpread !== null) sampler.add(symbol, at, halfSpread)
    } catch (error) {
      // Un símbolo sin libro no frena al resto; un Binance caído sí corta la pasada.
      if (!isSymbolScoped(error)) throw error
    }
  }
}

export async function saveObservedSpreads(repos: Pick<Repos, 'symbols'>, sampler: SpreadSampler, symbols: readonly string[], now: number): Promise<void> {
  for (const symbol of symbols) {
    const observed = sampler.median(symbol, now)
    if (observed !== null) await repos.symbols.setObservedSpread(symbol, observed)
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
