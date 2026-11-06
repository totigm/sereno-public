// El universo de la sesión real. En mainnet es el mismo que el de papel (mismos contratos,
// mismos volúmenes). En testnet el catálogo y los volúmenes siguen siendo los de mainnet (los
// de testnet no dicen nada del mercado), pero sólo entran las monedas que testnet lista, con
// sus filtros: son los que Binance valida en cada orden de allá. Los filtros de testnet
// viven en memoria: `symbols` es de mainnet y lo comparte la de papel.

import type { SymbolRecord } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import { refreshUniverse, type UniverseDeps, type UniverseRefresh } from '../live/universe-refresh'

export interface RealUniverseDeps {
  mainnet: UniverseDeps
  // Sólo en testnet.
  testnet: Pick<BinanceRest, 'exchangeInfo'> | null
}

export function realUniverse({ mainnet, testnet }: RealUniverseDeps): UniverseRefresh {
  return async (input) => {
    const refreshed = await refreshUniverse(mainnet, input)
    if (!testnet) return refreshed
    const listed = new Map((await testnet.exchangeInfo()).filter((c) => c.status === 'TRADING').map((c) => [c.symbol, c]))
    const open = new Set(input.openSymbols)
    const records = refreshed.records.flatMap((r): SymbolRecord[] => {
      const contract = listed.get(r.symbol)
      // La abierta conserva su contrato: el motor la tiene que poder retomar para cerrarla.
      if (!contract) return open.has(r.symbol) ? [r] : []
      const { minNotional, minQty, stepSize, tickSize, quantityPrecision } = contract.filters
      return [{ ...r, minNotional, minQty, stepSize, tickSize, quantityPrecision }]
    })
    // Una abierta en una moneda que testnet dejó de listar se cierra como deslistada.
    const gone = input.openSymbols.filter((s) => !listed.has(s))
    return {
      universe: {
        symbols: refreshed.universe.symbols.filter((s) => listed.has(s)),
        delisted: [...new Set([...refreshed.universe.delisted, ...gone])],
      },
      records,
    }
  }
}
