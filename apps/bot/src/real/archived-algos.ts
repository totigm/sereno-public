// Los stops y take profits que dejó en Binance una sesión real ya archivada (por ejemplo, si
// falló la cancelación al llegar al tope y Toti arrancó otra antes de la vuelta siguiente). Son
// `reduceOnly`: podrían cerrar después una posición que Toti abra a mano en esa moneda. Al
// arrancar, la sesión nueva los cancela si su prefijo es de una real archivada del mismo
// entorno y la moneda no tiene posición en Binance.
//
// Con una posición en la moneda se dejan: la base de la archivada pudo no registrar una
// apertura (el bot se cayó entre la orden y el guardado) y ese stop sería lo único que la
// protege. Se avisa para que Toti decida.

import type { Repos } from '@sereno/db'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { Logger } from '../logger'
import { parseClientId, sessionShort } from './client-id'
import { coinOf, reconciledPhrase, type RealNote } from './notes'

export interface ArchivedAlgosDeps {
  repos: Pick<Repos, 'sessions'>
  trade: Pick<BinanceTradeRest, 'openAlgoOrders' | 'cancelAlgo'>
  account: { position(symbol: string): { amount: number } | null }
  sessionId: string
  logger: Logger
}

// Las notas para el diario. Nunca frena el arranque: lo que no pudo, lo intenta el próximo.
export async function cancelArchivedAlgos(deps: ArchivedAlgosDeps): Promise<RealNote[]> {
  try {
    return await cancelThem(deps)
  } catch (err) {
    deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'No pude revisar los stops de las sesiones reales archivadas; lo intento en el próximo arranque')
    return []
  }
}

async function cancelThem({ repos, trade, account, sessionId, logger }: ArchivedAlgosDeps): Promise<RealNote[]> {
  const all = await repos.sessions.listAll()
  const env = all.find((s) => s.id === sessionId)?.binanceEnv
  if (!env) return []
  const own = sessionShort(sessionId)
  const archived = new Set(all.filter((s) => s.kind === 'live' && s.status === 'archived' && s.binanceEnv === env).map((s) => sessionShort(s.id)))
  archived.delete(own)
  if (archived.size === 0) return []

  const notes: RealNote[] = []
  for (const algo of await trade.openAlgoOrders()) {
    const short = parseClientId(algo.clientAlgoId)?.short
    if (short === undefined || !archived.has(short)) continue
    const what = algo.type === 'STOP_MARKET' ? 'un stop' : 'un take profit'
    const data = { clientAlgoId: algo.clientAlgoId }
    if ((account.position(algo.symbol)?.amount ?? 0) !== 0) {
      notes.push({
        kind: 'mismatch',
        symbol: algo.symbol,
        phrase: `En ${coinOf(algo.symbol)} quedó ${what} de una sesión real archivada y Binance muestra una posición: no lo toco. Si la posición es tuya, cancelalo a mano.`,
        data,
      })
      continue
    }
    try {
      await trade.cancelAlgo(algo.clientAlgoId)
    } catch (err) {
      logger.warn({ symbol: algo.symbol, clientAlgoId: algo.clientAlgoId, err: err instanceof Error ? err.message : String(err) }, 'No pude cancelar un algo de una sesión real archivada; lo intento en el próximo arranque')
      continue
    }
    notes.push({ kind: 'reconciled', symbol: algo.symbol, phrase: reconciledPhrase(algo.symbol, `quedaba ${what} de una sesión real archivada; lo cancelé`), data })
  }
  return notes
}
