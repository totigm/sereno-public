// Universo de cada día del replay (spec §5.1 y §9): la misma `selectUniverse` del vivo, con
// los contratos del exchangeInfo de hoy (los deslistados no están: sesgo de supervivencia,
// declarado en el reporte) y el volumen de la vela diaria del día anterior.

import type { Candle, ContractMeta } from '@sereno/core'
import { DAY_MS, utcDay } from '@sereno/core/src/replay/clock'
import { rejectContract } from '@sereno/core/src/universe/contract-filter'
import { selectUniverse } from '@sereno/core/src/universe/select-universe'
import type { Settings } from '@sereno/shared'
import { errorMessage, isSymbolScoped, type SymbolFailure } from '../jobs/errors'
import { forEachLimit } from '../jobs/pool'

const CONCURRENCY = 4

export interface UniverseInput {
  contracts: readonly ContractMeta[]
  // Inicio de cada día UTC del período, en orden.
  days: readonly number[]
  settings: Settings['universe']
}

export interface ReplayUniverse {
  symbolsByDay: Record<string, string[]>
  // El volumen del día anterior de cada candidata, por día: con él se rankea cada día.
  volumesByDay: Record<string, Record<string, number>>
  // Candidatas cuyas velas diarias Binance rechazó: sin volumen, no entran ningún día.
  skipped: SymbolFailure[]
}

// `loadDaily` trae las velas diarias cerradas con apertura en [from, to).
export async function replayUniverse(
  loadDaily: (symbol: string, from: number, to: number) => Promise<Candle[]>,
  { contracts, days, settings }: UniverseInput,
  progress: (done: number, total: number) => Promise<void>,
): Promise<ReplayUniverse> {
  const firstDay = days[0]
  const lastDay = days.at(-1)
  if (firstDay === undefined || lastDay === undefined) throw new RangeError('replay: el período no tiene días')
  // El filtro de historia sólo se afloja con los días: lo que no entra el último, no entra nunca.
  const candidates = contracts.filter(
    (c) =>
      !settings.excluded.includes(c.symbol) &&
      rejectContract(c, { today: lastDay, includeTradFi: settings.includeTradFi, minHistoryDays: settings.minHistoryDays }) === null,
  )
  const volumeByDay = new Map<number, Record<string, number>>(days.map((day) => [day, {}]))
  const skipped: SymbolFailure[] = []
  let done = 0
  await forEachLimit(candidates, CONCURRENCY, async ({ symbol, onboardDate }) => {
    try {
      for (const candle of await loadDaily(symbol, Math.max(firstDay - DAY_MS, onboardDate), lastDay)) {
        const volumes = volumeByDay.get(candle.openTime + DAY_MS)
        if (volumes) volumes[symbol] = candle.quoteVolume
      }
    } catch (error) {
      if (!isSymbolScoped(error)) throw error
      skipped.push({ symbol, error: errorMessage(error) })
    }
    await progress(++done, candidates.length)
  })
  const symbolsByDay: Record<string, string[]> = {}
  const volumesByDay: Record<string, Record<string, number>> = {}
  for (const day of days) {
    const volumes = volumeByDay.get(day) ?? {}
    symbolsByDay[utcDay(day)] = selectUniverse({ contracts: [...contracts], volumes, today: day, settings, openSymbols: [] }).symbols
    volumesByDay[utcDay(day)] = volumes
  }
  return { symbolsByDay, volumesByDay, skipped }
}
