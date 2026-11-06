import type { SessionRow } from '@sereno/db'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { ClientIds } from '../../src/real/client-id'
import { runRealOffCli } from '../../src/real/real-off'
import { tradeFor, type TradeKit } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'
import { seedOpen } from '../helpers/live'
import { createRealSession } from '../helpers/real-session'

const SOL = 'SOLUSDT'
const ETH = 'ETHUSDT'
const OPENED_AT = Date.UTC(2026, 10, 1, 11)

describe('pnpm bot real-off', { timeout: 20_000 }, () => {
  let fake: FakeBinance
  let t: TestDb
  let session: SessionRow
  let kit: TradeKit
  let ids: ClientIds
  let out: string[]
  let err: string[]

  beforeAll(async () => {
    fake = await FakeBinance.start()
    t = await openTestDb()
  })
  afterAll(async () => {
    await t.close()
    await fake.stop()
  })
  beforeEach(async () => {
    fake.reset()
    fake.trading.setMark(SOL, 150)
    fake.trading.setMark(ETH, 2_000)
    session = await createRealSession(t)
    kit = tradeFor(fake)
    ids = new ClientIds(session.id, Date.now)
    out = []
    err = []
  })
  afterEach(async () => {
    await t.query('delete from sessions where id = $1', [session.id])
  })

  const env = (keys = true): NodeJS.ProcessEnv => ({
    DATABASE_URL_UNPOOLED: 'postgresql://no-se-usa:5432/la-base-viene-en-deps',
    LOG_LEVEL: 'silent',
    BINANCE_ENV: 'mainnet',
    ...(keys ? { BINANCE_TRADE_API_KEY: FAKE_API_KEY, BINANCE_TRADE_API_SECRET: FAKE_API_SECRET } : {}),
  })

  // Los hosts de mainnet están fijos en el código: los pedidos se desvían al falso.
  const toFake: typeof fetch = (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(/^https:\/\/(fapi|api)\.binance\.com/, fake.baseUrl), init)

  function run(overrides: { keys?: boolean; fetch?: typeof fetch } = {}): Promise<number> {
    return runRealOffCli([], { env: env(overrides.keys ?? true), fetch: overrides.fetch ?? toFake, db: t.db, stdout: (line) => out.push(line), stderr: (line) => err.push(line) })
  }

  // Una abierta del bot: la orden con su id en Binance y la fila en la base.
  async function botOpen(symbol: string, qty: number, price: number) {
    await kit.trade.marketOrder({ symbol, side: 'BUY', quantity: String(qty), reduceOnly: false, clientOrderId: ids.next('o') })
    return seedOpen(t, session.id, { symbol, entryPrice: price, stopPrice: price * 0.95, qty, openedAt: OPENED_AT })
  }

  const amount = (symbol: string) => fake.trading.position(symbol)?.amount ?? 0
  const orders = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/fapi/v1/order')

  it('cierra sólo la cantidad del bot', async () => {
    await botOpen(SOL, 1, 150)
    fake.trading.manualPosition(SOL, 2)
    expect(amount(SOL)).toBe(3)

    expect(await run()).toBe(0)

    expect(amount(SOL)).toBe(2)
    const close = orders().at(-1)!
    expect(close.query).toMatchObject({ symbol: SOL, side: 'SELL', quantity: '1', reduceOnly: 'true' })
    expect(close.query.newClientOrderId).toMatch(new RegExp(`^sereno-${ids.short}-x`))
    expect(out.join('\n')).toContain('SOL')
    // No escribe posiciones: las cierra la reconciliación del bot.
    expect((await t.repos.positions.listOpen(session.id)).map((p) => p.symbol)).toEqual([SOL])
  })

  it('no toca una moneda que es de Toti', async () => {
    await botOpen(SOL, 1, 150)
    fake.trading.manualPosition(ETH, 0.5)
    const before = orders().length

    expect(await run()).toBe(0)

    expect(amount(ETH)).toBe(0.5)
    expect(amount(SOL)).toBe(0)
    expect(orders().slice(before).map((o) => o.query.symbol)).toEqual([SOL])
  })

  it('cancela los stops y take profit del prefijo y ninguno ajeno', async () => {
    await botOpen(SOL, 1, 150)
    fake.trading.manualPosition(ETH, 0.5)
    const stop = ids.next('s')
    const takeProfit = ids.next('t')
    await kit.trade.algoOrder({ symbol: SOL, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '140', quantity: '1', clientAlgoId: stop })
    await kit.trade.algoOrder({ symbol: SOL, side: 'SELL', type: 'TAKE_PROFIT_MARKET', triggerPrice: '170', quantity: '1', clientAlgoId: takeProfit })
    await kit.trade.algoOrder({ symbol: ETH, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '1900', quantity: '0.5', clientAlgoId: 'web_stop_de_toti' })

    expect(await run()).toBe(0)

    const status = Object.fromEntries(fake.trading.algos.map((a) => [a.clientAlgoId, a.algoStatus]))
    expect(status).toEqual({ [stop]: 'CANCELED', [takeProfit]: 'CANCELED', web_stop_de_toti: 'NEW' })
  })

  it('una que no pudo cerrar conserva su stop; la que cerró, no', async () => {
    await botOpen(SOL, 1, 150)
    await botOpen(ETH, 0.5, 2_000)
    const solStop = ids.next('s')
    const ethStop = ids.next('s')
    await kit.trade.algoOrder({ symbol: SOL, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '140', quantity: '1', clientAlgoId: solStop })
    await kit.trade.algoOrder({ symbol: ETH, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '1900', quantity: '0.5', clientAlgoId: ethStop })
    // Las dos abrieron a la vez: va primero ETH (por su id). Binance rechaza su cierre; el de SOL entra.
    fake.trading.rejectNext('/fapi/v1/order', -2019)

    expect(await run()).toBe(1)

    expect(amount(ETH)).toBe(0.5)
    expect(amount(SOL)).toBe(0)
    const status = Object.fromEntries(fake.trading.algos.map((a) => [a.clientAlgoId, a.algoStatus]))
    expect(status).toEqual({ [solStop]: 'CANCELED', [ethStop]: 'NEW' })
    expect(out).toContainEqual(expect.stringMatching(/^ETH: no la pude cerrar y le dejé el stop puesto: ./))
    expect(out.at(-1)).toBe('Cerré 1 de 2; la operación quedó apagada.')
  })

  // El bot está caído, así que la base quedó vieja: dice que el bot tiene 1 abierto.
  async function botOpenWithStop(symbol: string, qty: number, price: number) {
    const position = await botOpen(symbol, qty, price)
    const stop = ids.next('s')
    await kit.trade.algoOrder({ symbol, side: 'SELL', type: 'STOP_MARKET', triggerPrice: String(price * 0.9), quantity: String(qty), clientAlgoId: stop })
    await t.repos.positions.upsertOpen(session.id, { ...position, stopOrderId: stop })
    return stop
  }

  it('el stop del bot ya disparó: deja lo de Toti entero', async () => {
    await botOpenWithStop(SOL, 1, 150)
    fake.trading.manualPosition(SOL, 2)
    fake.trading.setMark(SOL, 130)
    expect(amount(SOL)).toBe(2)
    const before = orders().length

    expect(await run()).toBe(0)

    expect(amount(SOL)).toBe(2)
    expect(orders().slice(before)).toEqual([])
    expect(out).toContain('SOL: el stop del bot ya la había cerrado en Binance; lo que queda es tuyo y no lo toco.')
  })

  it('el stop del bot ya no está y nada dice por qué: no toca la moneda y avisa', async () => {
    const stop = await botOpenWithStop(SOL, 1, 150)
    fake.trading.manualPosition(SOL, 2)
    await kit.trade.cancelAlgo(stop)
    const before = orders().length

    expect(await run()).toBe(1)

    expect(amount(SOL)).toBe(3)
    expect(orders().slice(before)).toEqual([])
    expect(out).toContain('SOL: el stop del bot ya no está en Binance y no sé si lo que hay es del bot o tuyo: no cierro nada ahí. Revisalo en Binance.')
    expect(out.at(-1)).toBe('Cerré 0 de 1; la operación quedó apagada.')
  })

  it('si no puede comprobar una moneda, sigue con las demás y cancela los stops de las que cerró', async () => {
    // Va primero ETH (por su id); SOL tiene 1 del bot y 2 de Toti.
    const ethStop = await botOpenWithStop(ETH, 0.5, 2_000)
    const solStop = await botOpenWithStop(SOL, 1, 150)
    fake.trading.manualPosition(SOL, 2)
    const solTradesDown: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/fapi/v1/userTrades') && url.includes(`symbol=${SOL}`)) return Promise.resolve(new Response(JSON.stringify({ code: -1000, msg: 'An unknown error occured while processing the request.' }), { status: 500 }))
      return toFake(input, init)
    }

    expect(await run({ fetch: solTradesDown })).toBe(1)

    expect(amount(ETH)).toBe(0)
    expect(amount(SOL)).toBe(3)
    const status = Object.fromEntries(fake.trading.algos.map((a) => [a.clientAlgoId, a.algoStatus]))
    expect(status).toEqual({ [ethStop]: 'CANCELED', [solStop]: 'NEW' })
    expect(out).toContainEqual(expect.stringMatching(/^SOL: no pude comprobar en Binance si lo que hay es del bot; no cierro nada ahí y le dejé el stop puesto: ./))
    expect(out.at(-1)).toBe('Cerré 1 de 2; la operación quedó apagada.')
  })

  // El bot se cayó entre la orden y el guardado: Binance tiene la posición del bot con su stop
  // y la base no la conoce. Con el bot sin responder, nadie más le volvería a poner el stop.
  async function unrecordedWithStop(symbol: string, qty: number, triggerPrice: string): Promise<string> {
    await kit.trade.marketOrder({ symbol, side: 'BUY', quantity: String(qty), reduceOnly: false, clientOrderId: ids.next('o') })
    const stop = ids.next('s')
    await kit.trade.algoOrder({ symbol, side: 'SELL', type: 'STOP_MARKET', triggerPrice, quantity: String(qty), clientAlgoId: stop })
    return stop
  }

  it('una posición del bot que la base no registró se cierra como al adoptarla, y recién después se cancela su stop', async () => {
    const stop = await unrecordedWithStop(SOL, 1, '140')
    fake.trading.manualPosition(SOL, 2)

    expect(await run()).toBe(0)

    // Cierra lo que explica la orden `o` del bot; lo de Toti queda.
    expect(amount(SOL)).toBe(2)
    expect(orders().at(-1)!.query).toMatchObject({ symbol: SOL, side: 'SELL', quantity: '1', reduceOnly: 'true', newClientOrderId: expect.stringMatching(new RegExp(`^sereno-${ids.short}-x`)) })
    expect(fake.trading.findAlgo({ clientAlgoId: stop })?.algoStatus).toBe('CANCELED')
    expect(out).toContain('SOL: Binance tenía 1 del bot que la base no registró (me caí entre la orden y el guardado); lo cerré a mercado.')
  })

  it('una posición con stops del bot que nada explica conserva el stop', async () => {
    // El bot abrió y cerró; después Toti abrió del mismo lado y quedó un stop del bot en la moneda.
    const stop = await unrecordedWithStop(SOL, 1, '140')
    await kit.trade.marketOrder({ symbol: SOL, side: 'SELL', quantity: '1', reduceOnly: true, clientOrderId: ids.next('c') })
    fake.trading.manualPosition(SOL, 2)
    const before = orders().length

    expect(await run()).toBe(1)

    expect(amount(SOL)).toBe(2)
    expect(orders().slice(before)).toEqual([])
    expect(fake.trading.findAlgo({ clientAlgoId: stop })?.algoStatus).toBe('NEW')
    expect(out).toContain('SOL: Binance tiene una posición con stops del bot que la base no registró y no sé si es del bot: no cierro nada ahí y le dejé el stop puesto. Revisalo en Binance.')
  })

  it('si no puede comprobar una posición que la base no registró, conserva su stop', async () => {
    const stop = await unrecordedWithStop(SOL, 1, '140')
    const tradesDown: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/fapi/v1/userTrades')) return Promise.resolve(new Response(JSON.stringify({ code: -1000, msg: 'An unknown error occured while processing the request.' }), { status: 500 }))
      return toFake(input, init)
    }

    expect(await run({ fetch: tradesDown })).toBe(1)

    expect(amount(SOL)).toBe(1)
    expect(fake.trading.findAlgo({ clientAlgoId: stop })?.algoStatus).toBe('NEW')
    expect(out).toContainEqual(expect.stringMatching(/^SOL: no pude comprobar en Binance si la posición que la base no registró es del bot; no cierro nada ahí y le dejé el stop puesto: ./))
  })

  it('una sesión sin entorno guardado: la apaga y no toca ninguna cuenta', async () => {
    await botOpen(SOL, 1, 150)
    await t.query('update sessions set binance_env = null where id = $1', [session.id])
    const before = orders().length

    expect(await run()).toBe(1)

    expect(out.at(-1)).toBe('La sesión no dice de qué cuenta de Binance es: no toco ninguna.')
    expect(orders()).toHaveLength(before)
    expect((await t.repos.sessions.get(session.id))?.realStatus).toBe('off')
  })

  it('anota en el diario cuándo la apagó', async () => {
    const at = Date.UTC(2026, 10, 1, 13)
    expect(await runRealOffCli([], { env: env(), fetch: toFake, db: t.db, now: () => at, stdout: (line) => out.push(line), stderr: (line) => err.push(line) })).toBe(0)
    const events = await t.repos.realEvents.list(session.id, { from: 0, to: at + 1 })
    expect(events.map((e) => [e.kind, e.at])).toEqual([['off', at]])
  })

  it('sin claves sale con 2 y no toca la base', async () => {
    await botOpen(SOL, 1, 150)
    const before = fake.requests.length

    expect(await run({ keys: false })).toBe(2)

    expect(err).toEqual(['Faltan BINANCE_TRADE_API_KEY y BINANCE_TRADE_API_SECRET: no puedo hablar con Binance.'])
    expect((await t.repos.sessions.get(session.id))?.realStatus).toBe('on')
    expect(fake.requests.length).toBe(before)
  })

  it('deja la sesión apagada aunque Binance falle', async () => {
    await botOpen(SOL, 1, 150)
    const broken: typeof fetch = async () => new Response(JSON.stringify({ code: -1000, msg: 'An unknown error occured while processing the request.' }), { status: 500 })

    expect(await run({ fetch: broken })).toBe(1)

    const row = await t.repos.sessions.get(session.id)
    expect({ status: row?.realStatus, reason: row?.realOffReason }).toEqual({ status: 'off', reason: 'user' })
    expect(amount(SOL)).toBe(1)
  })

  it('sin sesión real activa no hace nada', async () => {
    await t.query(`update sessions set status = 'archived', ended_at = now() where id = $1`, [session.id])

    expect(await run()).toBe(0)

    expect(out).toEqual(['No hay una sesión con plata real activa.'])
    expect(orders()).toEqual([])
  })
})
