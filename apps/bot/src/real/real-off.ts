// `pnpm bot real-off`: el interruptor de la sesión con plata real desde la terminal, para
// cuando el dashboard o el bot no responden. Primero la deja apagada en la base (si el bot
// está vivo, deja de abrir con su próxima lectura); después cierra a mercado lo del bot, nunca
// lo de Toti, y recién entonces cancela los stops y take profits del bot. Una que no se pudo
// cerrar conserva los suyos: con el bot sin responder, nadie más se los volvería a poner.
// Con el bot caído la base puede estar vieja: antes de cerrar una moneda se comprueba que lo
// del bot siga ahí (`stillTheBots`), porque lo que Binance muestra puede ser todo de Toti.
// Una moneda con stops del bot y una posición en Binance que la base no registró (el bot se
// cayó entre la orden y el guardado) se cierra como cualquier otra del bot si un fill `o` de la
// sesión la explica, como la adoptaría el bot al arrancar; si nada la explica, o no se puede
// comprobar, conserva sus stops.
// No escribe posiciones: el bot las cierra en la base al reconciliar (el id `x` dice que fue
// este interruptor). No pide `SERENO_REAL_TRADING`: apagar siempre se puede.

import { createDirectDb, createRepos, type Db, type PositionRecord } from '@sereno/db'
import type { BinanceEnv } from '@sereno/shared'
import { RateLimiter } from '../binance/rate-limiter'
import { classifyBinanceError } from '../binance/trade-errors'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { AlgoOrder, BinancePosition } from '../binance/trade-types'
import { BINANCE_LIMITS, loadConfig } from '../config'
import { loadRootEnv } from '../env'
import { errorMessage } from '../jobs/errors'
import { createLogger } from '../logger'
import { adoptionFill } from './adoption'
import { ClientIds, parseClientId } from './client-id'
import { closedUnderneath } from './closing-fill'
import { coinOf, isBinanceFailure } from './notes'
import type { PendingClose } from './pending-close'
import { realTradeRest } from './process'

export interface RealOffCliDeps {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  db?: Db
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  now?: () => number
}

// Un interruptor no espera minutos a Binance: dos reintentos cortos y después dice qué faltó.
const HTTP = { maxRetries: 2, backoffBaseMs: 500 }
// Sin los contratos a mano: las cantidades de Binance están en su grilla, esto sólo absorbe
// el redondeo de sumarlas.
const QTY_TOLERANCE = 1e-9
// Margen sobre el reloj local para el fin de la búsqueda de trades (relojes desfasados).
const CLOCK_SKEW_MS = 60_000

// Devuelve el código de salida: 0 si quedó todo cerrado, 1 si algo falló, 2 sin claves.
export async function runRealOffCli(_args: readonly string[], deps: RealOffCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line))
  const err = deps.stderr ?? ((line: string) => console.error(line))
  if (!deps.env) loadRootEnv()
  const config = loadConfig(deps.env ?? process.env)
  const logger = createLogger({ level: config.logLevel, pretty: process.stderr.isTTY })
  const trade = realTradeRest(config.real, new RateLimiter({ ...BINANCE_LIMITS }), logger, { ...HTTP, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  if (!trade) {
    err('Faltan BINANCE_TRADE_API_KEY y BINANCE_TRADE_API_SECRET: no puedo hablar con Binance.')
    return 2
  }
  const env = config.real.env
  const now = deps.now ?? Date.now
  const run = (db: Db): Promise<number> =>
    switchOffActive(db, env, trade, now, out).catch((error: unknown) => {
      err(`No pude terminar: ${errorMessage(error)}`)
      return 1
    })
  if (deps.db) return run(deps.db)
  const db = createDirectDb(config.databaseUrl, { max: 1 })
  try {
    return await run(db)
  } finally {
    await db.$client.end()
  }
}

// La sesión `live` activa: la apaga primero, después limpia Binance.
async function switchOffActive(db: Db, env: BinanceEnv, trade: BinanceTradeRest, now: () => number, out: (line: string) => void): Promise<number> {
  const repos = createRepos(db)
  const session = await repos.sessions.getActive('live')
  if (!session) {
    out('No hay una sesión con plata real activa.')
    return 0
  }
  await repos.sessions.setRealStatus(session.id, 'off', 'user')
  await repos.realEvents.append(session.id, [{ at: now(), kind: 'off', symbol: null, phrase: 'Apagaste la operación con plata real desde la terminal.' }])
  out('Apagué la operación con plata real: el bot ya no abre.')
  if (session.binanceEnv === null) {
    out('La sesión no dice de qué cuenta de Binance es: no toco ninguna.')
    return 1
  }
  if (session.binanceEnv !== env) {
    out(`La sesión es de ${envName(session.binanceEnv)} y el bot está configurado para ${envName(env)}: no toco esa cuenta.`)
    return 1
  }
  const ok = await switchOff({ trade, ids: new ClientIds(session.id, now), now, out }, await repos.positions.listOpen(session.id))
  return ok ? 0 : 1
}

interface SwitchOffContext {
  trade: BinanceTradeRest
  ids: ClientIds
  now: () => number
  out: (line: string) => void
}

// Cierra las abiertas del bot y después cancela sus algos, salvo los de una moneda que no se
// pudo cerrar; true si no quedó nada del bot en Binance. Sin las posiciones y los algos de
// Binance no se toca nada: los stops siguen cubriendo.
async function switchOff(ctx: SwitchOffContext, open: readonly PositionRecord[]): Promise<boolean> {
  const { trade, out } = ctx
  let positions: Map<string, BinancePosition>
  let algos: AlgoOrder[]
  try {
    positions = new Map((await trade.positionRisk()).map((p) => [p.symbol, p]))
    algos = (await trade.openAlgoOrders()).filter((a) => parseClientId(a.clientAlgoId)?.short === ctx.ids.short)
  } catch (error) {
    out(`No pude leer las posiciones y los stops de Binance: ${binanceMessage(error)}`)
    out(`Cerré 0 de ${open.length}; la operación quedó apagada.`)
    return false
  }
  const failed = new Set<string>()
  for (const position of open) {
    const live = positions.get(position.symbol)
    const sameSide = live !== undefined && live.amount * (position.side === 'long' ? 1 : -1) > 0
    // Lo de la moneda puede ser todo de Toti: sin pruebas de que el bot sigue ahí, no se cierra.
    const verdict = sameSide ? await stillTheBots(ctx, position, live, algos.filter((a) => a.symbol === position.symbol)) : 'bot'
    if (verdict === 'unknown') failed.add(position.symbol)
    if (verdict !== 'bot') continue
    if (!(await closeBotPart(ctx, position, live))) failed.add(position.symbol)
  }
  const recorded = new Set(open.map((p) => p.symbol))
  const unrecorded = [...new Set(algos.map((a) => a.symbol))].filter((symbol) => !recorded.has(symbol) && positions.has(symbol))
  for (const symbol of unrecorded) {
    if (!(await closeUnrecorded(ctx, positions.get(symbol)!))) failed.add(symbol)
  }
  const cancelled = await cancelBotAlgos(trade, ctx.ids.short, failed, out)
  const total = open.length + unrecorded.length
  out(failed.size === 0 && cancelled ? 'Cerré todo y apagué la operación con plata real.' : `Cerré ${total - failed.size} de ${total}; la operación quedó apagada.`)
  return failed.size === 0 && cancelled
}

// Una posición de Binance con stops del bot que la base no tiene: si la explica un fill `o` de
// la sesión, se cierra lo que llenó esa orden (nunca más que lo que Binance muestra). true si no
// queda nada del bot en la moneda.
async function closeUnrecorded({ trade, ids, now, out }: SwitchOffContext, live: BinancePosition): Promise<boolean> {
  const coin = coinOf(live.symbol)
  let fill
  try {
    fill = await adoptionFill(trade, live.symbol, live.amount, ids.short, now())
  } catch (error) {
    out(`${coin}: no pude comprobar en Binance si la posición que la base no registró es del bot; no cierro nada ahí y le dejé el stop puesto: ${binanceMessage(error)}`)
    return false
  }
  if (fill === null) {
    out(`${coin}: Binance tiene una posición con stops del bot que la base no registró y no sé si es del bot: no cierro nada ahí y le dejé el stop puesto. Revisalo en Binance.`)
    return false
  }
  const qty = plainQty(Math.min(fill.qty, Math.abs(live.amount)))
  try {
    await trade.marketOrder({ symbol: live.symbol, side: live.amount > 0 ? 'SELL' : 'BUY', quantity: qty, reduceOnly: true, clientOrderId: ids.next('x') })
  } catch (error) {
    out(`${coin}: no pude cerrar lo del bot que la base no registró y le dejé el stop puesto: ${binanceMessage(error)}`)
    return false
  }
  out(`${coin}: Binance tenía ${qty} del bot que la base no registró (me caí entre la orden y el guardado); lo cerré a mercado.`)
  return true
}

// A mercado `reduceOnly` por lo del bot: la menor entre su cantidad y la de Binance del mismo
// lado. true si no queda nada del bot en la moneda.
async function closeBotPart({ trade, ids, out }: SwitchOffContext, position: PositionRecord, live: BinancePosition | undefined): Promise<boolean> {
  const coin = coinOf(position.symbol)
  const sign = position.side === 'long' ? 1 : -1
  const binanceQty = live ? live.amount * sign : 0
  if (binanceQty <= 0) {
    out(`${coin}: Binance no tiene una posición del bot; no hay nada que cerrar.`)
    return true
  }
  // Las dos cantidades están en la grilla del contrato: la menor también.
  const qty = Math.min(position.qty, binanceQty)
  try {
    await trade.marketOrder({ symbol: position.symbol, side: position.side === 'long' ? 'SELL' : 'BUY', quantity: plainQty(qty), reduceOnly: true, clientOrderId: ids.next('x') })
  } catch (error) {
    out(`${coin}: no la pude cerrar y le dejé el stop puesto: ${binanceMessage(error)}`)
    return false
  }
  out(`${coin}: cerré ${plainQty(qty)} a mercado.`)
  return true
}

// ¿Lo que Binance muestra del lado del bot incluye todavía su posición? 'closed' si se prueba
// que se cerró (un algo suyo disparó, o la moneda quedó en cero desde la apertura: lo de ahora
// es de Toti), 'unknown' si su stop ya no está y nada dice por qué o si Binance no contestó,
// 'bot' si no. No tira: una moneda que no se pudo comprobar no frena a las demás ni la
// cancelación de los stops de las que ya se cerraron.
async function stillTheBots({ trade, now, out }: SwitchOffContext, position: PositionRecord, live: BinancePosition, algos: readonly AlgoOrder[]): Promise<'bot' | 'closed' | 'unknown'> {
  const coin = coinOf(position.symbol)
  const recorded = [position.stopOrderId, position.tpOrderId].filter((id): id is string => id !== null)
  let close: PendingClose | null
  try {
    close = await closedUnderneath(
      trade,
      {
        symbol: position.symbol,
        side: position.side,
        qty: position.qty,
        since: position.openedAt,
        until: now() + CLOCK_SKEW_MS,
        clientAlgoIds: [...new Set([...recorded, ...algos.map((a) => a.clientAlgoId)])],
        liquidationPrice: position.liquidationPrice,
        stepSize: QTY_TOLERANCE,
      },
      live.amount,
    )
  } catch (error) {
    out(`${coin}: no pude comprobar en Binance si lo que hay es del bot; no cierro nada ahí y le dejé el stop puesto: ${binanceMessage(error)}`)
    return 'unknown'
  }
  if (close) {
    out(`${coin}: ${closedHow(close)} en Binance; lo que queda es tuyo y no lo toco.`)
    return 'closed'
  }
  // Una que la base guarda con stop y que ya no lo tiene en Binance: se lo cancelaron a mano o
  // el bot la dio por desaparecida. Cerrar ahí puede tocar lo de Toti.
  if (position.stopOrderId !== null && !algos.some((a) => a.type === 'STOP_MARKET')) {
    out(`${coin}: el stop del bot ya no está en Binance y no sé si lo que hay es del bot o tuyo: no cierro nada ahí. Revisalo en Binance.`)
    return 'unknown'
  }
  return 'bot'
}

function closedHow(close: PendingClose): string {
  const how: Record<PendingClose['reason'], string> = {
    stop: 'el stop del bot ya la había cerrado',
    take_profit: 'el take profit del bot ya la había cerrado',
    liquidation: 'Binance ya la había liquidado',
    close_all: 'el interruptor ya la había cerrado',
    unprotected: 'ya se había cerrado',
    closed_on_exchange: 'ya se había cerrado',
  }
  return how[close.reason]
}

// Todo stop y take profit de la sesión (por el prefijo de su id), nunca uno ajeno ni uno de
// una moneda en `keep` (una abierta del bot que no se pudo cerrar).
async function cancelBotAlgos(trade: BinanceTradeRest, short: string, keep: ReadonlySet<string>, out: (line: string) => void): Promise<boolean> {
  try {
    const own = (await trade.openAlgoOrders()).filter((a) => parseClientId(a.clientAlgoId)?.short === short && !keep.has(a.symbol))
    for (const algo of own) await trade.cancelAlgo(algo.clientAlgoId)
    out(own.length === 0 ? 'No había stops ni take profits del bot para cancelar.' : `Cancelé ${own.length} ${own.length === 1 ? 'orden' : 'órdenes'} de stop y take profit del bot.`)
    return true
  } catch (error) {
    out(`No pude cancelar los stops del bot: ${binanceMessage(error)}`)
    return false
  }
}

// En castellano y sin el pedido firmado.
function binanceMessage(error: unknown): string {
  return isBinanceFailure(error) ? classifyBinanceError(error).message : errorMessage(error)
}

function plainQty(qty: number): string {
  return qty.toFixed(8).replace(/\.?0+$/, '')
}

function envName(env: BinanceEnv): string {
  return env === 'mainnet' ? 'real' : 'testnet'
}
