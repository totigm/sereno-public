import type { RealEventInput } from '@sereno/db'
import { DEFAULT_SETTINGS, REAL_CHECK_IDS, type RealCheck, type RealGate, type RealStatus } from '@sereno/shared'
import type { DemoReadiness, DemoSession } from '../dataset'
import type { LiveSpec } from '../live'
import { MINUTE_MS } from '../time'
import { activeForced, activeTrades, hoursAgo, type LiveScenarioContext } from './active'

// La sesión con plata real junto a la simulación de `active` (spec real): US$ 100 en
// testnet desde hace cinco días, con algunos de los mismos trades (el mismo motor sobre
// el mismo mercado, en monedas cuyo mínimo entra con ese capital), sin sombra, con los
// números marcados como de Binance y lo que pasó con Binance en `real_events`.

export const REAL_SESSION_ID = 'real_demo_testnet'

const REAL_TRADES = new Set(['a10', 'a12', 'a13', 'o02'])
const REAL_CAPITAL = 100

export type RealVariant = 'on' | 'loss_floor'

export function realSpec(ctx: LiveScenarioContext): LiveSpec {
  const ago = hoursAgo(ctx.botSeenAt)
  const startedAt = ago(130) - 12 * MINUTE_MS
  return {
    id: REAL_SESSION_ID,
    name: 'Plata real',
    capitalInicial: REAL_CAPITAL,
    startedAt,
    learningOrigin: 'zero',
    settings: [{ at: startedAt, by: ctx.ownerEmail, patch: { risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.5 } } }],
    trades: activeTrades(ago).filter((t) => REAL_TRADES.has(t.id)),
    degraded: null,
    forced: activeForced(),
  }
}

const GATE: Record<RealVariant, RealGate> = {
  on: { mode: 'trading', missing: [] },
  loss_floor: { mode: 'reduce_only', missing: [] },
}

/** La simulación armada con `realSpec`, vuelta sesión real: tipo, estado, gate, sin sombra y con los números de Binance. */
export function asRealSession(session: DemoSession, variant: RealVariant, botSeenAt: number): DemoSession {
  const ago = hoursAgo(botSeenAt)
  const status: RealStatus = variant
  const books = session.books && {
    real: {
      ...session.books.real,
      positions: session.books.real.positions.map((p) => ({
        ...p,
        // Lo que informa Binance: precio, cantidad, comisión y funding.
        events: p.events.map((e) => (['open', 'close', 'liquidation', 'funding'].includes(e.kind) ? { ...e, payload: { ...e.payload, reported: true } } : e)),
      })),
    },
    shadow: { ...session.books.shadow, positions: [] },
  }
  const events: RealEventInput[] = [
    {
      at: ago(20) + 4 * MINUTE_MS,
      kind: 'foreign_position',
      symbol: 'SOLUSDT',
      phrase: 'Tenés una posición tuya en SOL; no la toco.',
    },
    {
      at: ago(7) + 2 * MINUTE_MS,
      kind: 'reconciled',
      symbol: 'AVAXUSDT',
      phrase: 'Binance tenía el stop del short en AVAX en otro precio que la base: dejé el de la base.',
    },
    ...(variant === 'loss_floor'
      ? [{ at: ago(1) + 3 * MINUTE_MS, kind: 'loss_floor' as const, phrase: 'La sesión tocó el tope de pérdida: cerré todo y la apagué.' }]
      : []),
  ]
  return {
    ...session,
    row: {
      ...session.row,
      kind: 'live',
      binanceEnv: 'testnet',
      realStatus: status,
      realChangedAt: new Date(variant === 'on' ? session.row.startedAt?.getTime() ?? botSeenAt : ago(1) + 3 * MINUTE_MS),
    },
    books,
    equity: session.equity.map((p) => ({ ...p, shadowEquity: null })),
    bot: session.bot && { ...session.bot, status: { ...session.bot.status, real: GATE[variant] } },
    realEvents: events,
  }
}

const allOk = (): RealCheck[] => REAL_CHECK_IDS.map((id) => ({ id, status: 'ok', detail: '' }))

// En testnet no hay `apiRestrictions` ni `feeBurn` confiables: esos cuatro se saltean.
const TESTNET_SKIPPED = new Set(['futures_enabled', 'no_withdrawals', 'ip_restricted', 'fee_burn_off'])

/** Los chequeos que dejó el bot: frescos y en verde con la sesión prendida; viejos y con la hora corrida después del tope. */
export function realReadiness(variant: RealVariant, botSeenAt: number): DemoReadiness {
  const checks = allOk().map((c): RealCheck => {
    if (TESTNET_SKIPPED.has(c.id)) return { ...c, status: 'skipped', detail: 'En testnet no existe: lo salteo.' }
    if (variant === 'loss_floor' && c.id === 'clock') return { ...c, status: 'fail', detail: 'La Mac está 1,4 s corrida de Binance.' }
    return c
  })
  return {
    env: 'testnet',
    checkedAt: variant === 'on' ? botSeenAt - 2 * MINUTE_MS : botSeenAt - 22 * MINUTE_MS,
    enabled: true,
    keysPresent: true,
    checks,
    walletAvailable: 142.6,
    instanceId: 'mac-toti-7f3a9c',
  }
}
