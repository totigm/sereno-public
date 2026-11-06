'use client'

import { coinName } from '@sereno/core/src/journal/coin-name'
import type { Settings } from '@sereno/shared'
import { Button } from '@/components/ui/button'
import type { UniverseActions } from './use-universe'
import { withExcluded, withPinned } from './universe'

export interface CoinActionsProps {
  symbol: string
  actions: UniverseActions
  /** Sin conexión con el bot: se ven, pero deshabilitadas y con la explicación. */
  offline: boolean
  /** Tiene una abierta: excluida, sigue en el tablero hasta cerrarla. */
  holding: boolean
}

interface HintState {
  pinned: boolean
  excluded: boolean
  holding: boolean
  topN: number
  offline: boolean
}

function hint({ pinned, excluded, holding, topN, offline }: HintState): string {
  if (offline) return 'Sin conexión con el bot: vas a poder fijarla o excluirla cuando vuelva.'
  if (pinned) return `Está fijada: sigue en el tablero aunque salga del top ${topN}.`
  if (excluded) {
    return holding
      ? 'Está excluida: la cuido hasta cerrar la posición y después sale del tablero.'
      : 'Está excluida: sale del tablero en cuanto el bot tome el cambio.'
  }
  const exclusion = holding ? 'Excluirla la saca cuando cierre esta posición.' : 'Excluirla la saca del tablero.'
  return `Fijarla la deja en el tablero aunque salga del top ${topN}. ${exclusion}`
}

/**
 * Fijar y excluir desde la hoja de la moneda (spec §5.1, §11.1): escriben
 * `settings.universe` y avisan con "Deshacer". Sólo en la simulación activa. La hoja
 * queda abierta: el botón y la explicación muestran enseguida el estado nuevo, y el
 * aviso con "Deshacer" aparece por encima.
 */
export function CoinActions({ symbol, actions, offline, holding }: CoinActionsProps) {
  const { universe, pending, apply } = actions
  if (universe === null) return null
  const name = coinName(symbol)
  const pinned = universe.pinned.includes(symbol)
  const excluded = universe.excluded.includes(symbol)
  const busy = pending !== null
  const run = (key: string, next: Settings['universe'], message: string) => void apply(key, next, message)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={offline || busy}
          pending={pending === `pin:${symbol}`}
          onClick={() => run(`pin:${symbol}`, withPinned(universe, symbol, !pinned), pinned ? `Dejaste de fijar ${name}.` : `Fijaste ${name}.`)}
        >
          {pinned ? 'Dejar de fijar' : 'Fijar'}
        </Button>
        <Button
          disabled={offline || busy}
          pending={pending === `exclude:${symbol}`}
          onClick={() =>
            run(`exclude:${symbol}`, withExcluded(universe, symbol, !excluded), excluded ? `Volviste a incluir ${name}.` : `Excluiste ${name}.`)
          }
        >
          {excluded ? 'Volver a incluir' : 'Excluir'}
        </Button>
      </div>
      <p className="text-[0.8125rem] leading-snug text-pretty text-muted">{hint({ pinned, excluded, holding, topN: universe.topN, offline })}</p>
    </div>
  )
}
