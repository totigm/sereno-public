import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Repos } from '@sereno/db'
import { ACCOUNT_TIERS_AUTHOR, ACCOUNT_TIERS_PHRASE, DEFAULT_SETTINGS } from '@sereno/shared'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BinanceRest } from '../../src/binance/rest'
import { BINANCE_LIMITS } from '../../src/config'
import { accountTiersJob, KEY_REJECTED_MESSAGE } from '../../src/jobs/account-tiers'
import { refreshSymbols } from '../../src/jobs/symbols'
import type { AccountHookContext } from '../../src/live/live-types'
import { createLogger, silentLogger, type Logger } from '../../src/logger'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'
import { logSink } from '../helpers/log-sink'

const SESSION = 'ses_tk_account_tiers'

// Lo que el Binance falso devuelve para las monedas perpetuas del catálogo (fake/account-fixtures).
const ACCOUNT_MMR = {
  '1000PEPEUSDT': 0.015,
  BTCUSDT: 0.004,
  ETHUSDT: 0.005,
  NEWUSDT: 0.025,
  SOLUSDT: 0.01,
  USDCUSDT: 0.005,
  XAUUSDT: 0.01,
}

let t: TestDb
let fake: FakeBinance
let reported: string[]

function restWith({ apiKey = FAKE_API_KEY, apiSecret = FAKE_API_SECRET, logger = silentLogger }: { apiKey?: string | null; apiSecret?: string | null; logger?: Logger } = {}): BinanceRest {
  return new BinanceRest({
    baseUrl: fake.baseUrl,
    limiter: new RateLimiter({ ...BINANCE_LIMITS }),
    apiKey,
    apiSecret,
    maxRetries: 1,
    sleep: async () => {},
    logger,
  })
}

function context(repos: AccountHookContext['repos'] = t.repos): AccountHookContext {
  return { sessionId: SESSION, repos, reportError: (message) => void reported.push(message) }
}

async function settingsRow() {
  const row = await t.repos.settings.get(SESSION)
  if (!row) throw new Error('la sesión de prueba no tiene ajustes')
  return row
}

beforeAll(async () => {
  t = await openTestDb()
  fake = await FakeBinance.start()
  // El catálogo de contratos, como lo deja el refresco diario.
  await refreshSymbols({ rest: restWith(), repos: t.repos, logger: silentLogger }, DEFAULT_SETTINGS.risk)
})

afterAll(async () => {
  await t.query('delete from sessions where id = $1', [SESSION])
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  await seedSession(t, SESSION)
  await t.repos.settings.create(SESSION, DEFAULT_SETTINGS)
  fake.reset()
  reported = []
})

describe('accountTiersJob', () => {
  it('con clave guarda el mmr de tier 1 de las monedas del catálogo y las comisiones, como una versión del bot', async () => {
    const outcome = await accountTiersJob({ rest: restWith(), logger: silentLogger }, context())
    expect(outcome).toBe('updated')

    const row = await settingsRow()
    expect(row.version).toBe(2)
    expect(row.updatedBy).toBe(ACCOUNT_TIERS_AUTHOR)
    expect(row.config.risk).toEqual({ ...DEFAULT_SETTINGS.risk, mmrBySymbol: ACCOUNT_MMR, takerFeeRate: 0.00045, makerFeeRate: 0.00018 })
    // El trimestral y lo que no está en el catálogo no entran.
    expect(row.config.risk.mmrBySymbol).not.toHaveProperty('BTCUSDT_261226')
    expect(row.config.risk.mmrBySymbol).not.toHaveProperty('ZZZUSDT')

    // Una sola entrada nueva en el historial, hecha por el bot: de ella sale la del diario.
    const history = await t.repos.settings.history(SESSION)
    expect(history.map((h) => [h.version, h.changedBy])).toEqual([
      [2, ACCOUNT_TIERS_AUTHOR],
      [1, null],
    ])
    expect(history[0]!.config.risk.takerFeeRate).toBe(0.00045)
    expect(reported).toEqual([])
    expect(fake.requests.map((r) => r.path).sort()).toEqual(['/fapi/v1/commissionRate', '/fapi/v1/leverageBracket', '/fapi/v1/time'])
    expect(fake.requests.find((r) => r.path === '/fapi/v1/commissionRate')!.query.symbol).toBe('BTCUSDT')
  })

  it('una segunda corrida con los mismos valores no escribe', async () => {
    const rest = restWith()
    await accountTiersJob({ rest, logger: silentLogger }, context())
    const outcome = await accountTiersJob({ rest, logger: silentLogger }, context())
    expect(outcome).toBe('unchanged')
    expect((await settingsRow()).version).toBe(2)
    expect(await t.repos.settings.history(SESSION)).toHaveLength(2)
  })

  it('sin clave no llama a Binance ni toca los ajustes', async () => {
    for (const rest of [restWith({ apiKey: null, apiSecret: null }), restWith({ apiSecret: null })]) {
      expect(await accountTiersJob({ rest, logger: silentLogger }, context())).toBe('no_key')
    }
    expect(fake.requests).toEqual([])
    expect((await settingsRow()).version).toBe(1)
    expect(reported).toEqual([])
  })

  it('con -2015 deja una línea clara en los errores recientes, no reintenta y los ajustes quedan intactos', async () => {
    fake.rejectKey()
    const outcome = await accountTiersJob({ rest: restWith(), logger: silentLogger }, context())
    expect(outcome).toBe('rejected')
    expect(reported).toEqual([KEY_REJECTED_MESSAGE])
    expect(KEY_REJECTED_MESSAGE).toBe('La clave de Binance no tiene permiso de lectura de futuros: sigo con los supuestos')
    expect((await settingsRow()).version).toBe(1)
    expect(fake.requests.filter((r) => r.path === '/fapi/v1/leverageBracket')).toHaveLength(1)
  })

  it('si Binance no contesta, lo dice en los errores recientes y no toca los ajustes', async () => {
    fake.failNext('/fapi/v1/leverageBracket', { status: 503 }, 5)
    expect(await accountTiersJob({ rest: restWith(), logger: silentLogger }, context())).toBe('failed')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatch(/^No pude traer el mmr y las comisiones de tu cuenta de Binance: .*HTTP 503/)
    expect((await settingsRow()).version).toBe(1)
  })

  it('si Toti guardó en el medio, relee y reintenta una vez sin pisar su cambio', async () => {
    let raced = false
    const racing: AccountHookContext['repos'] = {
      ...t.repos,
      settings: {
        ...t.repos.settings,
        update: async (...args: Parameters<Repos['settings']['update']>) => {
          if (!raced) {
            raced = true
            const row = await settingsRow()
            await t.repos.settings.update(SESSION, { risk: { ...row.config.risk, riskPerTrade: 0.02 } }, row.version, { by: 'toti@example.com' })
          }
          return t.repos.settings.update(...args)
        },
      },
    }
    expect(await accountTiersJob({ rest: restWith(), logger: silentLogger }, context(racing))).toBe('updated')
    const row = await settingsRow()
    expect(row.version).toBe(3)
    expect(row.config.risk).toMatchObject({ riskPerTrade: 0.02, takerFeeRate: 0.00045, mmrBySymbol: ACCOUNT_MMR })
  })

  it('con dos conflictos seguidos se rinde hasta la próxima corrida y lo dice', async () => {
    const conflicting: AccountHookContext['repos'] = {
      ...t.repos,
      settings: { ...t.repos.settings, update: async () => ({ ok: false, version: 99 }) },
    }
    expect(await accountTiersJob({ rest: restWith(), logger: silentLogger }, context(conflicting))).toBe('failed')
    expect(reported).toEqual(['Los ajustes cambiaron mientras guardaba el mmr y las comisiones de tu cuenta de Binance: vuelvo a probar mañana'])
    expect((await settingsRow()).version).toBe(1)
  })

  it('ningún log tiene el secret ni la firma, tampoco con reintentos, -1021 o la clave rechazada', async () => {
    const sink = logSink()
    const logger = createLogger({ level: 'trace', destination: sink.stream })
    const rest = restWith({ logger })
    const deps = { rest, logger }

    fake.failNext('/fapi/v1/commissionRate', { status: 503 })
    await accountTiersJob(deps, context())
    // El reloj de Binance salta: -1021, se vuelve a medir y se reintenta.
    fake.now = () => Date.now() + 60_000
    await t.repos.settings.update(SESSION, { risk: DEFAULT_SETTINGS.risk }, (await settingsRow()).version)
    expect(await accountTiersJob(deps, context())).toBe('updated')
    expect(fake.requests.filter((r) => r.path === '/fapi/v1/time')).toHaveLength(2)
    fake.rejectKey()
    await accountTiersJob(deps, context())

    const lines = sink.lines()
    const text = JSON.stringify(lines)
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining([ACCOUNT_TIERS_PHRASE, KEY_REJECTED_MESSAGE, 'Binance: reintento con espera']))
    expect(text).not.toContain(FAKE_API_SECRET)
    expect(text).not.toContain(FAKE_API_KEY)
    expect(text).not.toMatch(/signature/i)
    const signatures = fake.requests.map((r) => new URLSearchParams(r.rawQuery).get('signature')).filter((s): s is string => s !== null)
    expect(signatures.length).toBeGreaterThan(3)
    for (const signature of signatures) expect(text).not.toContain(signature)
  })
})
