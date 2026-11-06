import type { CommandView } from '@/lib/live/types'

export type CancelProgress = { kind: 'idle' } | { kind: 'cancelling' } | { kind: 'failed'; message: string }

const IDLE: CancelProgress = { kind: 'idle' }
const CANCELLING: CancelProgress = { kind: 'cancelling' }

/** El `cancel_replay` pedido y el reloj de la base (`now` del vivo) al pedirlo. */
export interface CancelRequest {
  id: string
  at: number
}

/**
 * En qué quedó el "Cancelar" de un replay que corre, según lo que trae el vivo del
 * comando `cancel_replay` que se pidió. Recién encolado todavía no aparece, y hecho, el
 * replay sigue en la lista hasta la próxima lectura: en los dos casos, cancelando. Si el
 * bot no pudo, se dice por qué y se puede volver a pedir.
 *
 * El vivo trae sólo los últimos comandos: si ya trae otros posteriores al pedido y éste
 * no está, salió de la ventana y su resultado no se ve. Manda el estado del replay en la
 * sesión: si sigue corriendo (la única fila que muestra esto), no se queda cancelando.
 */
export function cancelProgress(request: CancelRequest | undefined, commands: readonly CommandView[]): CancelProgress {
  if (request === undefined) return IDLE
  const command = commands.find((c) => c.id === request.id)
  if (!command) return commands.some((c) => c.createdAt > request.at) ? IDLE : CANCELLING
  if (command.status === 'failed' || command.expired) {
    return { kind: 'failed', message: command.result?.message ?? 'El bot no pudo cancelar el replay. Probá de nuevo.' }
  }
  return command.status === 'cancelled' ? IDLE : CANCELLING
}
