// Antes de cerrar a mercado una posición del bot: ¿ya disparó en Binance uno de sus stops o
// take profits? El fill del disparo llega por el user data stream y la marca por otro socket,
// así que el respaldo por tick del motor (o un cierre pedido justo después) puede llegar
// antes que el evento. Con la moneda sólo del bot, la orden `c` de más es inofensiva (Binance
// la rechaza con −2022 y el cerrador toma el disparo); con Toti en la moneda, en cambio, esa
// orden `reduceOnly` por la cantidad del bot se ejecuta contra lo de Toti. Por eso:
//
// - Si la última marca ya cruzó el precio de un algo vivo del bot, Binance lo dispara con esa
//   misma marca: se espera su evento (a lo sumo `fillTimeoutMs`) y, si no llega, se lo busca
//   por REST.
// - Si puede haber en la moneda algo de Toti (Binance muestra otra cantidad que la del bot, o
//   la cuenta no lo puede saber porque el user data stream está caído), se pregunta por REST
//   por cada algo del bot antes de mandar nada, aunque la marca no lo cruce (un cierre pedido
//   con la marca que ya volvió o atrasada).
//
// null si nada disparó: quien llama cierra a mercado. Si REST no contesta, tira: no se sabe y
// no se manda nada.

import type { Side } from '@sereno/core'
import type { Clock } from '../live/timers'
import type { BotBook } from './bot-book'
import { triggeredByRest, type TriggerLookupApi } from './closing-fill'
import type { PendingClose } from './pending-close'
import type { LiveTrigger } from './protector'

export interface FiredTriggerDeps {
  book: Pick<BotBook, 'pricesOf' | 'waitClose'>
  trade: TriggerLookupApi
  clock: Clock
  fillTimeoutMs: number
}

export interface FiredTriggerQuery {
  symbol: string
  // El lado de la posición del bot.
  side: Side
  // Sus algos vivos (los que pueden disparar).
  live: readonly LiveTrigger[]
  // Todos los suyos en la moneda, para buscar el disparo por REST.
  algoIds: readonly string[]
  // Puede haber en la moneda algo que no es del bot: Binance muestra otra cantidad o, sin user
  // data stream, la cuenta no lo puede descartar.
  othersInCoin: boolean
}

export async function firedTrigger(deps: FiredTriggerDeps, q: FiredTriggerQuery): Promise<PendingClose | null> {
  const { mark } = deps.book.pricesOf(q.symbol)
  const crossed = q.live.some((algo) => crossedBy(algo, q.side, mark))
  if (crossed) {
    const event = await deps.book.waitClose(q.symbol, deps.fillTimeoutMs, deps.clock)
    if (event) return event
  } else if (!q.othersInCoin) {
    return null
  }
  return q.algoIds.length === 0 ? null : triggeredByRest(deps.trade, q.symbol, q.algoIds)
}

// Las reglas de Binance para un algo que reduce la posición: el stop de una larga dispara
// con la marca en su precio o por debajo, el take profit en su precio o por encima; en una
// corta, al revés.
export function crossedBy(algo: LiveTrigger, side: Side, mark: number): boolean {
  const below = mark <= algo.triggerPrice
  const above = mark >= algo.triggerPrice
  const protectsDownside = (algo.kind === 'stop') === (side === 'long')
  return protectsDownside ? below : above
}
