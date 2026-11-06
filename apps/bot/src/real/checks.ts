// Los chequeos de la cuenta de Binance antes de dejar operar a la sesión real (spec de
// plata real, "Cómo se prende", llave 3). Cada uno se revisa por separado: un error de
// Binance deja ese chequeo en `fail` con el mensaje clasificado (que nunca arrastra el
// pedido ni la firma) y no frena a los demás. Sin claves no se habla con Binance.

import { formatNumber, formatUsd, REAL_CHECK_IDS, type BinanceEnv, type RealCheck, type RealCheckId } from '@sereno/shared'
import { classifyBinanceError } from '../binance/trade-errors'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { ApiRestrictions } from '../binance/trade-types'

// Lo que los chequeos le piden a Binance. Más angosto que el `TradeApi` de la cuenta real
// (Task 7), que lo cumple.
export type ChecksTrade = Pick<BinanceTradeRest, 'apiRestrictions' | 'dualSide' | 'usdtBalance' | 'serverTime' | 'multiAssets' | 'feeBurn'>

// La sesión real activa, como la ven los chequeos.
export interface ChecksSession {
  env: BinanceEnv
  // Lo que la sesión tiene según sus cuentas, sin lo no realizado: el capital asignado al
  // crearla y después lo que le dejan las operaciones cerradas, comisiones y funding.
  saldo: number
  // Tiene margen puesto en Binance (posiciones u órdenes que abren).
  usesMargin: boolean
}

export interface RealChecksDeps {
  // null sin claves: `BinanceTradeRest` no se puede armar sin ellas.
  trade: ChecksTrade | null
  env: BinanceEnv
  keysPresent: boolean
  // null si no hay sesión real activa.
  session: ChecksSession | null
  now: () => number
}

export interface RealAccountReport {
  checks: RealCheck[]
  // USDT disponible para margen nuevo; null si no se pudo leer.
  walletAvailable: number | null
}

export const MAX_CLOCK_OFFSET_MS = 1_000

const TESTNET_SKIP = 'En testnet no existe: lo salteo.'
const NO_KEYS_SKIP = 'Sin las claves de operación no lo puedo revisar.'

type Outcome = Omit<RealCheck, 'id'>
type Attempt<T> = { ok: true; value: T } | { ok: false; message: string }

const ok = (detail: string): Outcome => ({ status: 'ok', detail })
const fail = (detail: string): Outcome => ({ status: 'fail', detail })
const skipped = (detail: string): Outcome => ({ status: 'skipped', detail })

export async function runRealChecks(deps: RealChecksDeps): Promise<RealCheck[]> {
  return (await inspectRealAccount(deps)).checks
}

// Los chequeos y, de paso, lo disponible en la billetera (el dashboard lo usa para validar
// el capital que Toti escribe al crear la sesión).
export async function inspectRealAccount(deps: RealChecksDeps): Promise<RealAccountReport> {
  const { trade, env } = deps
  if (!deps.keysPresent || trade === null) {
    return { checks: inOrder(withoutKeys()), walletAvailable: null }
  }
  const testnet = env === 'testnet'
  const [restrictions, dualSide, balance, clock, multiAssets, feeBurn] = await Promise.all([
    testnet ? null : attempt(() => trade.apiRestrictions()),
    attempt(() => trade.dualSide()),
    attempt(() => trade.usdtBalance()),
    attempt(() => readClock(trade, deps.now)),
    attempt(() => trade.multiAssets()),
    testnet ? null : attempt(() => trade.feeBurn()),
  ])
  const permissions = permissionChecks(restrictions)
  const outcomes: Record<RealCheckId, Outcome> = {
    keys: ok('Están cargadas BINANCE_TRADE_API_KEY y BINANCE_TRADE_API_SECRET.'),
    ...permissions,
    one_way: judge(dualSide, (dual) =>
      dual ? fail('La cuenta está en modo cobertura: pasala a una posición por moneda en Binance.') : ok('Una posición por moneda.'),
    ),
    wallet: walletCheck(balance, deps.session),
    clock: judge(clock, clockCheck),
    multi_assets_off: judge(multiAssets, (on) => (on ? fail('Está prendido: apagalo en Binance.') : ok('Está apagado.'))),
    fee_burn_off:
      feeBurn === null
        ? skipped(TESTNET_SKIP)
        : judge(feeBurn, (on) => (on ? fail('Está prendido: apagalo en Binance, así las comisiones se cobran en USDT.') : ok('Está apagado.'))),
    env_match: envCheck(deps.session?.env ?? null, env),
  }
  return { checks: inOrder(outcomes), walletAvailable: balance.ok ? balance.value.available : null }
}

function withoutKeys(): Record<RealCheckId, Outcome> {
  const outcomes = Object.fromEntries(REAL_CHECK_IDS.map((id) => [id, skipped(NO_KEYS_SKIP)])) as Record<RealCheckId, Outcome>
  return { ...outcomes, keys: fail('Falta BINANCE_TRADE_API_KEY o BINANCE_TRADE_API_SECRET en el .env.') }
}

// Los tres permisos salen del mismo pedido a `/sapi`; `null` es testnet, donde no existe.
function permissionChecks(restrictions: Attempt<ApiRestrictions | null> | null): Record<'futures_enabled' | 'no_withdrawals' | 'ip_restricted', Outcome> {
  if (restrictions === null) return { futures_enabled: skipped(TESTNET_SKIP), no_withdrawals: skipped(TESTNET_SKIP), ip_restricted: skipped(TESTNET_SKIP) }
  // En mainnet sin `/sapi` configurado no hay cómo saber los permisos: nunca se dan por buenos.
  const read: Attempt<ApiRestrictions> = !restrictions.ok
    ? restrictions
    : restrictions.value === null
      ? { ok: false, message: 'No tengo acceso a /sapi para leer los permisos de la clave.' }
      : { ok: true, value: restrictions.value }
  return {
    futures_enabled: judge(read, (r) =>
      r.enableFutures ? ok('Tiene futuros habilitados.') : fail('La clave no tiene futuros habilitados: activalos en la gestión de la API de Binance.'),
    ),
    no_withdrawals: judge(read, (r) => (r.enableWithdrawals ? fail('La clave puede hacer retiros: sacale ese permiso en Binance.') : ok('No puede hacer retiros.'))),
    ip_restricted: judge(read, (r) =>
      r.ipRestrict ? ok('Sólo funciona desde las IP que cargaste.') : fail('La clave funciona desde cualquier IP: restringila a la de esta Mac en Binance.'),
    ),
  }
}

// Corre cada 5 min, así que tiene que valer con la sesión andando, no sólo al crearla. Lo
// disponible baja con el margen en uso y con lo no realizado: con margen puesto se mira la
// billetera (sin lo no realizado), que como el saldo de la sesión sólo se mueve con lo
// realizado. A centavo: las cuentas de la sesión y las de Binance (8 decimales) difieren
// en la última cifra.
function walletCheck(balance: Attempt<{ wallet: number; available: number }>, session: ChecksSession | null): Outcome {
  if (session === null) return skipped('Todavía no hay una sesión real con capital asignado.')
  return judge(balance, ({ wallet, available }) => {
    const [have, where] = session.usesMargin ? [wallet, 'en la billetera'] : [available, 'disponibles']
    const text = `Hay ${formatUsd(have)} ${where} y el saldo de la sesión es ${formatUsd(session.saldo)}.`
    return toCents(have) >= toCents(session.saldo) ? ok(text) : fail(text)
  })
}

function clockCheck({ offset, roundTrip }: ClockReading): Outcome {
  const size = Math.abs(offset)
  // La hora de Binance cae en algún punto del viaje: la diferencia de verdad está a medio
  // viaje de la medida. Un pedido lento (reintentos, cola del limitador) no la da por mala.
  const atLeast = Math.max(0, size - roundTrip / 2)
  if (size < MAX_CLOCK_OFFSET_MS) return ok(`La diferencia es de ${formatDuration(size)}.`)
  if (atLeast < MAX_CLOCK_OFFSET_MS) {
    return ok(`Medí ${formatDuration(size)} de diferencia, pero el pedido tardó ${formatDuration(roundTrip)}: no alcanza para asegurar que pase de 1 s.`)
  }
  // offset = Binance − Mac: positivo, la Mac va atrasada.
  return fail(`La hora de la Mac está ${formatDuration(atLeast)} ${offset > 0 ? 'atrasada' : 'adelantada'} respecto de la de Binance; tiene que ser menos de 1 s.`)
}

function envCheck(sessionEnv: BinanceEnv | null, env: BinanceEnv): Outcome {
  if (sessionEnv === null) return skipped('Todavía no hay una sesión real.')
  if (sessionEnv === env) return ok(`La sesión y el bot son de ${place(env)}.`)
  return fail(`La sesión es de ${place(sessionEnv)} y el bot corre en ${place(env)} (BINANCE_ENV=${env}).`)
}

function place(env: BinanceEnv): string {
  return env === 'mainnet' ? 'la cuenta real' : 'testnet'
}

interface ClockReading {
  // Binance − Mac, contra el punto medio del pedido.
  offset: number
  roundTrip: number
}

async function readClock(trade: ChecksTrade, now: () => number): Promise<ClockReading> {
  const before = now()
  const serverTime = await trade.serverTime()
  const after = now()
  return { offset: serverTime - (before + after) / 2, roundTrip: after - before }
}

function toCents(usd: number): number {
  return Math.round(usd * 100)
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${formatNumber(ms / 1_000, 1)} s`
}

async function attempt<T>(read: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (err) {
    return { ok: false, message: classifyBinanceError(err).message }
  }
}

function judge<T>(read: Attempt<T>, decide: (value: T) => Outcome): Outcome {
  return read.ok ? decide(read.value) : fail(read.message)
}

function inOrder(outcomes: Record<RealCheckId, Outcome>): RealCheck[] {
  return REAL_CHECK_IDS.map((id) => ({ id, ...outcomes[id] }))
}
