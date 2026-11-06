import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REAL_CHECK_IDS, type RealCheck, type RealCheckId } from '@sereno/shared'
import { FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { inspectRealAccount, runRealChecks, type ChecksSession, type RealChecksDeps } from '../../src/real/checks'
import { tradeFor } from '../helpers/binance'

const T0 = Date.parse('2026-11-01T12:00:00Z')
const TESTNET_SKIP = 'En testnet no existe: lo salteo.'

describe('runRealChecks contra el Binance falso', () => {
  let fake: FakeBinance

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    fake.now = () => T0
  })

  const deps = (patch: Partial<RealChecksDeps> = {}): RealChecksDeps => ({
    trade: tradeFor(fake).trade,
    env: 'mainnet',
    keysPresent: true,
    session: { env: 'mainnet', saldo: 50, usesMargin: false },
    now: () => T0,
    ...patch,
  })
  const run = async (patch: Partial<RealChecksDeps> = {}): Promise<Record<RealCheckId, RealCheck>> => {
    const checks = await runRealChecks(deps(patch))
    return Object.fromEntries(checks.map((c) => [c.id, c])) as Record<RealCheckId, RealCheck>
  }
  const session = (patch: Partial<ChecksSession>): Partial<RealChecksDeps> => ({ session: { env: 'mainnet', saldo: 50, usesMargin: false, ...patch } })
  const statuses = (checks: Record<RealCheckId, RealCheck>) => REAL_CHECK_IDS.map((id) => `${id}:${checks[id].status}`)

  it('una cuenta en orden pasa todo, uno por id y en orden', async () => {
    const checks = await runRealChecks(deps())
    expect(checks.map((c) => c.id)).toEqual([...REAL_CHECK_IDS])
    expect(checks.every((c) => c.status === 'ok' && c.detail.length > 0)).toBe(true)
  })

  it('retiros habilitados → no_withdrawals fail', async () => {
    fake.trading.config({ restrictions: { enableFutures: true, enableWithdrawals: true, ipRestrict: true } })
    const checks = await run()
    expect(checks.no_withdrawals.status).toBe('fail')
    expect(checks.futures_enabled.status).toBe('ok')
  })

  it('sin futuros ni restricción de IP → fail', async () => {
    fake.trading.config({ restrictions: { enableFutures: false, enableWithdrawals: false, ipRestrict: false } })
    const checks = await run()
    expect([checks.futures_enabled.status, checks.ip_restricted.status, checks.no_withdrawals.status]).toEqual(['fail', 'fail', 'ok'])
  })

  it('dualSide true → one_way fail', async () => {
    fake.trading.config({ dualSide: true })
    expect((await run()).one_way.status).toBe('fail')
  })

  it('serverTimeOffsetMs 1500 → clock fail', async () => {
    fake.trading.config({ serverTimeOffsetMs: 1_500 })
    const checks = await run()
    expect(checks.clock).toMatchObject({ status: 'fail' })
    expect(checks.clock.detail).toContain('1,5 s')
    // Las firmas se ajustan al desfase: el resto se pudo revisar igual.
    expect(checks.one_way.status).toBe('ok')
  })

  it('el reloj pasa con menos de 1 s de diferencia y falla justo en 1 s', async () => {
    fake.trading.config({ serverTimeOffsetMs: -999 })
    expect((await run()).clock.status).toBe('ok')
    fake.trading.config({ serverTimeOffsetMs: -1_000 })
    expect((await run()).clock.status).toBe('fail')
  })

  it('un pedido lento no basta para dar el reloj por malo: se descuenta medio viaje', async () => {
    // La Mac lee 11:59:59 antes del pedido y 12:00:01 después: punto medio T0, viaje de 2 s.
    const slow = (): (() => number) => {
      const reads = [T0 - 1_000, T0 + 1_000]
      return () => reads.shift() ?? T0 + 1_000
    }
    fake.trading.config({ serverTimeOffsetMs: 1_500 })
    const unsure = (await run({ now: slow() })).clock
    expect(unsure).toMatchObject({ status: 'ok', detail: expect.stringContaining('tardó 2,0 s') })
    fake.trading.config({ serverTimeOffsetMs: 2_500 })
    // Aun con el viaje entero de margen, van por lo menos 1,5 s de diferencia.
    expect((await run({ now: slow() })).clock).toMatchObject({ status: 'fail', detail: expect.stringContaining('1,5 s') })
  })

  it('multiAssets true → multi_assets_off fail; feeBurn true → fee_burn_off fail', async () => {
    fake.trading.config({ multiAssets: true, feeBurn: true })
    const checks = await run()
    expect([checks.multi_assets_off.status, checks.fee_burn_off.status]).toEqual(['fail', 'fail'])
  })

  it('sin margen en uso, lo disponible tiene que cubrir el saldo de la sesión; sin sesión se saltea', async () => {
    fake.trading.config({ wallet: 49.99 })
    expect((await run(session({ saldo: 50 }))).wallet.status).toBe('fail')
    expect((await run(session({ saldo: 49.99 }))).wallet.status).toBe('ok')
    expect((await run({ session: null })).wallet.status).toBe('skipped')
  })

  it('se compara a centavo: la última cifra de Binance no tumba la sesión', async () => {
    fake.trading.config({ wallet: 49.69999999 })
    expect((await run(session({ saldo: 49.7 }))).wallet.status).toBe('ok')
    expect((await run(session({ saldo: 49.71 }))).wallet.status).toBe('fail')
  })

  it('con una posición abierta, el margen en uso no la deja sin billetera', async () => {
    fake.trading.config({ wallet: 50 })
    fake.trading.setMark('BTCUSDT', 20_000)
    fake.trading.manualPosition('BTCUSDT', 0.01)
    // 200 de nocional a 20x: 10 de margen, más la comisión de entrada.
    expect(fake.trading.available()).toBeLessThan(40)
    const saldo = fake.trading.walletBalance()
    const checks = await run(session({ saldo, usesMargin: true }))
    expect(checks.wallet.status).toBe('ok')
    expect(checks.wallet.detail).toContain('en la billetera')
    // Si la billetera queda por debajo del saldo (Toti sacó plata), falla igual con margen en uso.
    expect((await run(session({ saldo: saldo + 1, usesMargin: true }))).wallet.status).toBe('fail')
  })

  it('después de una pérdida realizada, alcanza con cubrir el saldo que le quedó a la sesión', async () => {
    fake.trading.config({ wallet: 50 })
    fake.trading.setMark('BTCUSDT', 20_000)
    fake.trading.manualPosition('BTCUSDT', 0.01)
    fake.trading.setMark('BTCUSDT', 19_000)
    fake.trading.manualPosition('BTCUSDT', -0.01)
    const saldo = fake.trading.walletBalance()
    expect(saldo).toBeLessThan(49)
    expect((await run(session({ saldo }))).wallet.status).toBe('ok')
  })

  it('el entorno de la sesión tiene que ser el del bot; sin sesión se saltea', async () => {
    expect((await run(session({ env: 'testnet' }))).env_match).toMatchObject({ status: 'fail', detail: expect.stringContaining('testnet') })
    expect((await run({ session: null })).env_match.status).toBe('skipped')
  })

  it('sapiEnabled false en testnet → los cuatro skipped, sin pedirle nada a /sapi ni a feeBurn', async () => {
    fake.sapiEnabled = false
    const checks = await run({ env: 'testnet', ...session({ env: 'testnet' }) })
    for (const id of ['no_withdrawals', 'ip_restricted', 'futures_enabled', 'fee_burn_off'] as const) {
      expect(checks[id]).toEqual({ id, status: 'skipped', detail: TESTNET_SKIP })
    }
    expect(statuses(checks).filter((s) => s.endsWith(':ok'))).toEqual(['keys:ok', 'one_way:ok', 'wallet:ok', 'clock:ok', 'multi_assets_off:ok', 'env_match:ok'])
    expect(fake.requests.filter((r) => r.path.startsWith('/sapi/') || r.path === '/fapi/v1/feeBurn')).toEqual([])
  })

  it('sin claves: keys fail y el resto skipped, sin hablar con Binance', async () => {
    const checks = await run({ trade: null, keysPresent: false })
    expect(checks.keys.status).toBe('fail')
    expect(checks.keys.detail).toContain('BINANCE_TRADE_API_KEY')
    expect(statuses(checks).slice(1).every((s) => s.endsWith(':skipped'))).toBe(true)
    expect(fake.requests).toEqual([])
  })

  it('un error de Binance en un chequeo lo deja en fail con el mensaje clasificado, sin frenar a los demás', async () => {
    fake.failNext('/fapi/v1/positionSide/dual', { status: 401, body: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' } })
    fake.failNext('/sapi/v1/account/apiRestrictions', { status: 500, body: { code: -1000, msg: 'boom' } })
    const checks = await run()
    expect(checks.one_way).toEqual({ id: 'one_way', status: 'fail', detail: 'Binance rechaza la clave: inválida, IP no autorizada o sin permiso' })
    // Los tres permisos salen de un mismo pedido: si falla, fallan los tres.
    for (const id of ['futures_enabled', 'no_withdrawals', 'ip_restricted'] as const) {
      expect(checks[id]).toMatchObject({ status: 'fail', detail: expect.stringContaining('HTTP 500') })
    }
    expect(checks.multi_assets_off.status).toBe('ok')
    expect(JSON.stringify(checks)).not.toContain(FAKE_API_SECRET)
    expect(JSON.stringify(checks)).not.toMatch(/signature/i)
  })

  it('en mainnet sin /sapi configurado, los permisos fallan (nunca se dan por buenos)', async () => {
    const checks = await run({ trade: tradeFor(fake, { sapi: false }).trade })
    for (const id of ['futures_enabled', 'no_withdrawals', 'ip_restricted'] as const) expect(checks[id].status).toBe('fail')
  })

  it('inspectRealAccount devuelve también lo disponible en la billetera', async () => {
    fake.trading.config({ wallet: 321.5 })
    await expect(inspectRealAccount(deps({ session: null }))).resolves.toMatchObject({ walletAvailable: 321.5 })
    fake.failNext('/fapi/v3/balance', { status: 500, body: { code: -1000, msg: 'boom' } })
    const failed = await inspectRealAccount(deps())
    expect(failed.walletAvailable).toBeNull()
    expect(failed.checks.find((c) => c.id === 'wallet')?.status).toBe('fail')
  })
})
