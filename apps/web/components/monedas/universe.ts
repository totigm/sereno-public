import type { Settings } from '@sereno/shared'

// Fijar y excluir son excluyentes (spec §5.1): fijar saca la moneda de las excluidas y
// excluir la saca de las fijadas. Cada cambio devuelve el grupo `universe` entero,
// que es lo que se escribe en los ajustes (y lo que vuelve a escribir "Deshacer").

type Universe = Settings['universe']

const without = (list: readonly string[], symbol: string): string[] => list.filter((s) => s !== symbol)

export function withPinned(universe: Universe, symbol: string, pinned: boolean): Universe {
  if (!pinned) return { ...universe, pinned: without(universe.pinned, symbol) }
  return { ...universe, pinned: [...without(universe.pinned, symbol), symbol], excluded: without(universe.excluded, symbol) }
}

export function withExcluded(universe: Universe, symbol: string, excluded: boolean): Universe {
  if (!excluded) return { ...universe, excluded: without(universe.excluded, symbol) }
  return { ...universe, excluded: [...without(universe.excluded, symbol), symbol], pinned: without(universe.pinned, symbol) }
}
