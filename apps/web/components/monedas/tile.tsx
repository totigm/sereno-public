'use client'

import clsx from 'clsx'
import { Chip } from '@/components/ui/chip'
import { formatPct, toneOfShown } from '@/lib/format'
import { LeanBar } from './lean-bar'
import { positionChip, tileLabel, tileStateText } from './phrases'
import type { TileModel } from './tile-model'
import { usePulse } from './use-pulse'

export interface TileProps {
  tile: TileModel
  theta: number
  /** Reloj de los estados ("espera 45 min"): el de la base, o el final de la sesión. */
  now: number
  /** Replay o simulación archivada: estados en pasado. */
  past: boolean
  /** Sin conexión: lo que depende del precio va apagado (spec §11.1). */
  stale: boolean
  onOpen: (symbol: string) => void
}

type Tone = 'gain' | 'loss' | 'muted'

// Según lo que se lee: "0,0%" va neutro aunque el cambio crudo sea +0,03 %.
const changeTone = (change: number, stale: boolean): Tone => (stale ? 'muted' : toneOfShown(change))

const toneText: Record<Tone, string> = { gain: 'text-gain', loss: 'text-loss', muted: 'text-muted' }

// Borde de 1,5px sin mover el contenido: 1px de borde más medio píxel de sombra interior.
const heldFrame: Record<Tone, string> = {
  gain: 'border-gain bg-gain-soft shadow-[inset_0_0_0_0.5px_var(--gain)]',
  loss: 'border-loss bg-loss-soft shadow-[inset_0_0_0_0.5px_var(--loss)]',
  muted: 'border-muted bg-muted/8 shadow-[inset_0_0_0_0.5px_var(--muted)]',
}

const glow: Record<Tone, string> = { gain: 'bg-gain/25', loss: 'bg-loss/25', muted: 'bg-muted/20' }

// Sobre el fondo tenue de la abierta, el chip tenue desaparece en claro: ahí va sobre la superficie.
const chipOnTint: Record<'long' | 'short', string> = {
  long: 'bg-surface! dark:bg-gain-soft!',
  short: 'bg-surface! dark:bg-loss-soft!',
}

/**
 * Una baldosa del tablero (spec §11.1): nombre y cambio de 24 h (o el chip de la
 * abierta) arriba, la barra de inclinación abajo; los estados reemplazan la barra
 * con su texto. Con posición lleva el borde y el fondo del resultado.
 */
export function Tile({ tile, theta, now, past, stale, onOpen }: TileProps) {
  const { state } = tile
  const held = state.kind === 'position'
  const { scope, pulse } = usePulse<HTMLLIElement>(held)
  const resultTone: Tone = !held || stale || state.net === null ? 'muted' : state.net >= 0 ? 'gain' : 'loss'
  const status = tileStateText(state, now, past)

  return (
    <li ref={scope} className="flex min-w-0">
      <button
        type="button"
        data-state={state.kind}
        data-pulse={pulse ?? undefined}
        aria-label={tileLabel(tile, now, past)}
        onClick={() => onOpen(tile.symbol)}
        className={clsx(
          'pressable relative flex w-full flex-col justify-between gap-2.5 overflow-hidden rounded-control border p-2.5 text-left',
          'transition-[background-color,border-color,box-shadow] duration-500 ease-out',
          held ? heldFrame[resultTone] : 'border-line bg-surface hover:border-muted/45',
          state.kind === 'penalized' && 'opacity-55',
        )}
      >
        <span aria-hidden data-pulse-glow className={clsx('pointer-events-none absolute inset-0 opacity-0', glow[resultTone])} />
        {/* En el celu (3 columnas, ~95px de contenido a 390px) el nombre y el cambio no entran
            en una fila: el cambio o el chip van debajo y el nombre usa todo el ancho. `truncate`
            queda como red para los nombres de más de unos 9 caracteres. */}
        <span
          data-testid="tile-top"
          className="relative flex min-w-0 items-center justify-between gap-1.5 max-[599px]:flex-col max-[599px]:items-start max-[599px]:justify-start max-[599px]:gap-0.5"
        >
          <span className="max-w-full min-w-0 truncate text-[0.9375rem] leading-5 font-semibold">{tile.name}</span>
          {held ? (
            <Chip tone={state.side === 'long' ? 'gain' : 'loss'} className={clsx('shrink-0 px-1.5 text-[0.6875rem] leading-[1.125rem]', chipOnTint[state.side])}>
              {positionChip(state.side, state.leverage)}
            </Chip>
          ) : (
            tile.change24h !== null && (
              <span className={clsx('shrink-0 text-[0.8125rem] leading-5 font-medium tabular-nums', toneText[changeTone(tile.change24h, stale)])}>
                {formatPct(tile.change24h)}
              </span>
            )
          )}
        </span>
        {/* En el celu "sin datos hace 15 min" no entra en una línea: puede ocupar dos y la fila de baldosas crece. */}
        <span className="relative flex min-h-3 items-center">
          {status === null ? (
            <LeanBar sPrime={tile.sPrime} theta={theta} />
          ) : (
            <span className="flex min-w-0 items-baseline gap-1.5 text-[0.6875rem] leading-[0.875rem] text-muted">
              {state.kind === 'degraded' && <span className="size-1.5 shrink-0 rounded-full bg-muted" />}
              <span className="line-clamp-2">{status}</span>
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
