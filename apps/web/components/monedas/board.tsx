import { Tile, type TileProps } from './tile'
import type { TileModel } from './tile-model'

export type BoardProps = Omit<TileProps, 'tile'> & {
  tiles: readonly TileModel[]
}

/**
 * La grilla de baldosas a todo el ancho (spec §11.1 y §11.2): 3 columnas en el celu
 * (2 bajo 360px), 5 en tablet y 6 en desktop, igual que su esqueleto.
 */
export function Board({ tiles, ...tile }: BoardProps) {
  return (
    <ul
      aria-label="Monedas del tablero"
      className="grid grid-cols-3 gap-1.5 max-[359px]:grid-cols-2 min-[600px]:grid-cols-5 desktop:grid-cols-6 desktop:gap-2"
    >
      {tiles.map((t) => (
        <Tile key={t.symbol} tile={t} {...tile} />
      ))}
    </ul>
  )
}
