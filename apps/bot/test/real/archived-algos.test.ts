import type { SessionRow } from '@sereno/db'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { silentLogger } from '../../src/logger'
import { cancelArchivedAlgos } from '../../src/real/archived-algos'
import { ClientIds } from '../../src/real/client-id'
import { tradeFor, type TradeKit } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'

const SOL = 'SOLUSDT'
const ETH = 'ETHUSDT'

describe('los stops que dejó una sesión real archivada', { timeout: 20_000 }, () => {
  let fake: FakeBinance
  let t: TestDb
  let kit: TradeKit
  let sessions: SessionRow[]

  beforeAll(async () => {
    fake = await FakeBinance.start()
    t = await openTestDb()
  })
  afterAll(async () => {
    await t.close()
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    fake.trading.setMark(SOL, 150)
    fake.trading.setMark(ETH, 2_000)
    kit = tradeFor(fake)
    sessions = []
  })
  afterEach(async () => {
    await t.query('delete from sessions where id = any($1)', [sessions.map((s) => s.id)])
  })

  // Cada una archiva la anterior; la última queda activa.
  async function realSessions(...envs: ('mainnet' | 'testnet')[]): Promise<SessionRow[]> {
    for (const binanceEnv of envs) {
      await t.query(`update sessions set status = 'archived', ended_at = now() where status = 'active' and kind = 'live'`)
      sessions.push(await t.repos.sessions.createReal({ capitalInicial: 1_000, lossCap: 0.5, binanceEnv }))
    }
    return sessions
  }

  async function stopOf(session: SessionRow, symbol: string, kind: 's' | 't' = 's'): Promise<string> {
    const clientAlgoId = new ClientIds(session.id, Date.now).next(kind)
    await kit.trade.algoOrder({ symbol, side: 'SELL', type: kind === 's' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET', triggerPrice: kind === 's' ? '140' : '170', quantity: '1', clientAlgoId })
    return clientAlgoId
  }

  const status = () => Object.fromEntries(fake.trading.algos.map((a) => [a.clientAlgoId, a.algoStatus]))
  const cancel = (current: SessionRow, account = { position: (symbol: string) => fake.trading.position(symbol) }) =>
    cancelArchivedAlgos({ repos: t.repos, trade: kit.trade, account, sessionId: current.id, logger: silentLogger })

  it('cancela los de una archivada del mismo entorno en una moneda sin posición', async () => {
    const [old, current] = await realSessions('mainnet', 'mainnet')
    const stop = await stopOf(old!, SOL)
    const takeProfit = await stopOf(old!, SOL, 't')

    const notes = await cancel(current!)

    expect(status()).toEqual({ [stop]: 'CANCELED', [takeProfit]: 'CANCELED' })
    expect(notes.map((n) => [n.kind, n.symbol, n.data])).toEqual([
      ['reconciled', SOL, { clientAlgoId: stop }],
      ['reconciled', SOL, { clientAlgoId: takeProfit }],
    ])
  })

  it('no toca los de la sesión actual, los de otro entorno ni los de Toti', async () => {
    const [otherEnv, current] = await realSessions('testnet', 'mainnet')
    const mine = await stopOf(current!, SOL)
    const testnet = await stopOf(otherEnv!, ETH)
    await kit.trade.algoOrder({ symbol: ETH, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '1900', quantity: '1', clientAlgoId: 'web_stop_de_toti' })

    expect(await cancel(current!)).toEqual([])

    expect(status()).toEqual({ [mine]: 'NEW', [testnet]: 'NEW', web_stop_de_toti: 'NEW' })
  })

  it('con una posición en la moneda lo deja puesto y avisa', async () => {
    const [old, current] = await realSessions('mainnet', 'mainnet')
    const stop = await stopOf(old!, SOL)
    fake.trading.manualPosition(SOL, 1)

    const notes = await cancel(current!)

    expect(status()).toEqual({ [stop]: 'NEW' })
    expect(notes).toEqual([expect.objectContaining({ kind: 'mismatch', symbol: SOL, data: { clientAlgoId: stop } })])
    expect(notes[0]!.phrase).toMatch(/SOL.*sesión real archivada/)
  })

  it('si Binance falla no frena el arranque', async () => {
    const [old, current] = await realSessions('mainnet', 'mainnet')
    const stop = await stopOf(old!, SOL)
    fake.failNext('/fapi/v1/openAlgoOrders', { status: 500, body: { code: -1000, msg: 'boom' } })

    expect(await cancel(current!)).toEqual([])

    expect(status()).toEqual({ [stop]: 'NEW' })
  })
})
