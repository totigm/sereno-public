'use client'

import { closeAllText } from '@/components/ajustes/bot-phrases'
import { glue } from '@/components/ajustes/glue'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import type { OpenPositionView } from '@/lib/live/types'

export interface PauseSheetProps {
  open: boolean
  onClose: () => void
  openPositions: readonly OpenPositionView[]
  onPause: () => void
  onPauseAndCloseAll: () => void
  /** Mandando el cierre: el botón espera la respuesta. */
  closing: boolean
}

/** "Pausar (sigo cuidando las 3 abiertas)", con el número de abiertas adentro. */
export function pauseKeepLabel(count: number): string {
  return `Pausar (sigo cuidando ${count === 1 ? 'la abierta' : `las ${count} abiertas`})`
}

/**
 * La hoja de "Pausar" con abiertas (spec §11.1): pausar y seguir cuidándolas, o pausar y
 * cerrarlas todas. Lo segundo es destructivo: el botón ya dice cuánto vale cerrarlas
 * ahora, así que la hoja misma es la confirmación.
 */
export function PauseSheet({ open, onClose, openPositions, onPause, onPauseAndCloseAll, closing }: PauseSheetProps) {
  const count = openPositions.length
  return (
    <Sheet open={open} onClose={onClose} title="Pausar el bot">
      <p className="text-pretty text-muted">No abro posiciones nuevas hasta que reanudes. ¿Qué hago con las abiertas?</p>
      <div className="mt-5 flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Button variant="primary" onClick={onPause} disabled={closing}>
            {pauseKeepLabel(count)}
          </Button>
          <p className="text-sm text-pretty text-muted">Siguen con su stop y su objetivo, como hasta ahora.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Button variant="danger" onClick={onPauseAndCloseAll} pending={closing}>
            Pausar y cerrar todo
          </Button>
          <p className="text-sm text-pretty text-muted">{glue(closeAllText(openPositions))}</p>
        </div>
        <Button variant="ghost" onClick={onClose} disabled={closing}>
          Cancelar
        </Button>
      </div>
    </Sheet>
  )
}
