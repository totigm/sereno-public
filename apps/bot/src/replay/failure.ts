// El `mensaje` de un replay que falló (spec §9), el que ve Toti en el dashboard: una frase
// según la clase del error. El texto técnico de pg, Binance o Node, casi siempre en inglés,
// queda en el log del bot.

import { isDatabaseError } from '@sereno/db'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../binance/errors'
import { WorkerExited } from './worker'

export function replayFailureMessage(error: unknown): string {
  if (error instanceof BinanceGeoBlocked) return 'Falló: Binance no deja bajar datos desde esta conexión (bloqueo por ubicación).'
  if (error instanceof BinanceRateLimited) return 'Falló: Binance frenó los pedidos por exceso de llamadas. Probá de nuevo en unos minutos.'
  if (error instanceof BinanceHttpError) {
    if (error.status >= 500) return 'Falló: Binance no respondió bien mientras bajaba los datos. Probá de nuevo más tarde.'
    return `Falló: Binance rechazó un pedido de datos (error ${error.status}).`
  }
  if (error instanceof BinanceNetworkError) return 'Falló: no pude conectarme con Binance. Revisá la conexión y pedilo de nuevo.'
  if (isDatabaseError(error)) return 'Falló: no pude leer o escribir en la base de datos. Probá de nuevo en un rato.'
  if (error instanceof WorkerExited) return 'Falló: el proceso que corría el replay se cortó sin terminar.'
  return 'Falló por un error inesperado. El detalle quedó en el log del bot.'
}
