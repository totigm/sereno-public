// Contrato entre el runtime y quien opera sobre el motor de la sesión (comandos, ciclos,
// precios): las operaciones corren de a una y lo que producen se guarda en orden.

import type { TradingEngine } from '@sereno/core/src/engine/engine'
import type { EngineSnapshot } from '@sereno/core/src/engine/types'
import type { Repos } from '@sereno/db'

export type ExtraWrite = (repos: Repos) => Promise<void>

export interface EngineLane {
  // Corre `op` sobre el motor y espera a que sus eventos queden guardados. `extra`, a
  // partir del resultado, agrega escrituras a la misma transacción.
  run<T>(op: (engine: TradingEngine) => Promise<T>, extra?: (result: T) => ExtraWrite | undefined): Promise<T>
  snapshot(): EngineSnapshot
}
