// El universo de cada día del replay en `universe_days` (spec §9: un replay se guarda con
// las mismas tablas que el vivo), así Monedas y Ajustes lo muestran en contexto de replay.
// Cada día es la selección del vivo con las monedas que se mantuvieron por tener abiertas
// (las que el replay evaluó fuera del universo) y sin las que Binance rechazó (no
// estuvieron en el replay; van en el reporte, `data.skipped`).

import type { ContractMeta } from '@sereno/core'
import { selectUniverse } from '@sereno/core/src/universe/select-universe'
import type { UniverseDay } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import { universeSnapshot } from '../jobs/universe-snapshot'

export interface UniverseDaysInput {
  contracts: readonly ContractMeta[]
  settings: Settings['universe']
  // Volumen del día anterior de cada candidata, por día UTC (`YYYY-MM-DD`).
  volumesByDay: Readonly<Record<string, Record<string, number>>>
  // El universo con que corrió el replay cada día.
  symbolsByDay: Readonly<Record<string, readonly string[]>>
  // Las monedas que el replay evaluó cada día (`ReplayResult.universeByDay`).
  evaluated: Readonly<Record<string, readonly string[]>>
}

export function replayUniverseDays({ contracts, settings, volumesByDay, symbolsByDay, evaluated }: UniverseDaysInput): UniverseDay[] {
  return Object.entries(symbolsByDay).map(([day, universe]) => {
    const inUniverse = new Set(universe)
    const held = (evaluated[day] ?? []).filter((symbol) => !inUniverse.has(symbol))
    const volumes = volumesByDay[day] ?? {}
    const selection = selectUniverse({ contracts: [...contracts], volumes, today: Date.parse(day), settings, openSymbols: held })
    const ran = new Set([...universe, ...held])
    const result = { ...selection, symbols: selection.symbols.filter((symbol) => ran.has(symbol)) }
    const { entries, excluded } = universeSnapshot(result, { contracts, volumes, pinned: settings.pinned })
    return { day, symbols: entries, excluded }
  })
}
