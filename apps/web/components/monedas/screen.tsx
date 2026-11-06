'use client'

import { useMemo } from 'react'
import type { UniverseExcluded } from '@sereno/db'
import { useLiveContext } from '@/lib/live/provider'
import type { CoinDetail, CoinInfo } from '@/lib/queries/monedas'
import type { SessionContext } from '@/lib/queries/session'
import { Board } from './board'
import { BoardEmpty } from './board-empty'
import { BoardHeader } from './board-header'
import { CoinActions } from './coin-actions'
import { CoinSheet } from './coin-sheet'
import { OutsideBoard } from './outside'
import type { BoardMode } from './phrases'
import { boardTiles } from './tile-model'
import { useSelectedCoin } from './use-selected-coin'
import { useUniverse } from './use-universe'

export interface MonedasScreenProps {
  /** Activa, replay o archivada: decide el tiempo verbal y si hay acciones sobre el bot. */
  context: SessionContext
  /** Base de las rutas de la sesión ('' en la activa). */
  base: string
  coins: Record<string, CoinInfo>
  excluded: UniverseExcluded
  detail: CoinDetail | null
  theta: number
}

function modeOf(context: SessionContext, offline: boolean): BoardMode {
  if (context.isReplay) return 'replay'
  if (!context.isActive) return 'archived'
  return offline ? 'offline' : 'live'
}

/**
 * La pantalla Monedas (spec §11.1): el tablero de baldosas con los datos en vivo del
 * shell, lo que quedó afuera, y la hoja de la moneda que dice la URL.
 */
export function MonedasScreen({ context, base, coins, excluded, detail, theta }: MonedasScreenProps) {
  const { data: live } = useLiveContext()
  const { selected, open, close } = useSelectedCoin()
  const universe = useUniverse(live.sessionId)
  const tiles = useMemo(() => boardTiles(live.market, live.open), [live.market, live.open])
  const onBoard = useMemo(() => new Set(tiles.map((t) => t.symbol)), [tiles])

  if (tiles.length === 0) return <BoardEmpty context={context} live={live} />

  const mode = modeOf(context, live.offline)
  const past = mode === 'replay' || mode === 'archived'
  const stale = mode === 'offline'
  const marksAt = live.market?.updatedAt ?? null
  // Los estados se cuentan desde el reloj de la base; en una sesión terminada, desde su final.
  const now = past ? (marksAt ?? live.now) : live.now
  const current = selected === null ? undefined : tiles.find((t) => t.symbol === selected)
  const position = current && live.open.find((p) => p.symbol === current.symbol)
  const shared = { theta, now, past, stale }

  return (
    <div className="column-wide flex flex-col pt-6">
      <BoardHeader count={tiles.length} open={live.open.length} mode={mode} marksAt={marksAt} />
      <div className="mt-5">
        <Board tiles={tiles} {...shared} onOpen={open} />
      </div>
      <OutsideBoard excluded={excluded} actions={universe} onBoard={onBoard} canAct={context.isActive} offline={live.offline} />
      <CoinSheet
        tile={current}
        info={current && coins[current.symbol]}
        detail={detail}
        position={position}
        {...shared}
        marksAt={marksAt}
        base={base}
        footer={
          context.isActive && current ? (
            <CoinActions symbol={current.symbol} actions={universe} offline={live.offline} holding={position !== undefined} />
          ) : null
        }
        onClose={close}
      />
    </div>
  )
}
