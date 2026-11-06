'use client'

import { useId } from 'react'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { UniverseExcluded } from '@sereno/db'
import { Button } from '@/components/ui/button'
import { exclusionText } from './phrases'
import type { UniverseActions } from './use-universe'
import { withExcluded } from './universe'

export interface OutsideBoardProps {
  /** Lo que el último universo del día dejó afuera, con su motivo. */
  excluded: UniverseExcluded
  actions: UniverseActions
  /** Las que están en el tablero: una excluida con posición sigue ahí hasta cerrarla. */
  onBoard: ReadonlySet<string>
  /** Simulación activa: se puede volver a incluir. */
  canAct: boolean
  offline: boolean
}

interface Row {
  symbol: string
  text: string
  includable: boolean
}

/**
 * Las monedas que Toti pidió y no están en el tablero (spec §5.1): las que excluyó, con
 * "Incluir", y las fijadas que no pasan un filtro, con el porqué. Las demás que filtra
 * el universo (stablecoins, TradFi, recién listadas) no se listan: nadie las pidió.
 */
export function OutsideBoard({ excluded, actions, onBoard, canAct, offline }: OutsideBoardProps) {
  const titleId = useId()
  const { universe, pending, apply } = actions
  if (universe === null) return null

  const rows: Row[] = [
    ...Object.entries(excluded)
      // El universo del día puede ser de antes del último cambio: manda lo que está fijado ahora.
      .filter(([symbol, entry]) => entry.pinned === true && universe.pinned.includes(symbol) && !onBoard.has(symbol))
      .map(([symbol, entry]) => ({ symbol, text: exclusionText(entry, universe.minHistoryDays), includable: false })),
    ...universe.excluded.filter((symbol) => !onBoard.has(symbol)).map((symbol) => ({ symbol, text: 'La excluiste.', includable: true })),
  ]
  if (rows.length === 0) return null

  return (
    <section aria-labelledby={titleId} className="mt-10 max-w-[640px]">
      <h2 id={titleId} className="text-[0.9375rem] font-semibold">
        Fuera del tablero
      </h2>
      <ul className="mt-2 border-b border-line">
        {rows.map((row) => {
          const name = coinName(row.symbol)
          return (
            <li key={row.symbol} className="flex min-h-12 items-center gap-3 border-t border-line py-2">
              <span className="w-14 shrink-0 truncate font-medium">{name}</span>
              <span className="min-w-0 flex-1 text-sm text-pretty text-muted">{row.text}</span>
              {canAct && row.includable && (
                <Button
                  aria-label={`Incluir ${name}`}
                  disabled={offline || pending !== null}
                  pending={pending === `exclude:${row.symbol}`}
                  onClick={() => void apply(`exclude:${row.symbol}`, withExcluded(universe, row.symbol, false), `Volviste a incluir ${name}.`)}
                >
                  Incluir
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
