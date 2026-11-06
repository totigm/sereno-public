import { COINS, symbolRow } from './coins'
import type { DemoDataset, DemoSession } from './dataset'
import type { LiveSpec } from './live'
import { buildPendingReplay, type FinishedReplaySpec } from './replay'
import { activeSpec, type LiveScenarioContext } from './scenarios/active'
import { asRealSession, realReadiness, realSpec, type RealVariant } from './scenarios/real'
import { shieldedSpec } from './scenarios/shielded'
import { HOUR_MS, MINUTE_MS, SECOND_MS } from './time'
import { buildWorld } from './world'

// Los escenarios de `pnpm demo --scenario <nombre>`. Cada uno reemplaza los datos de la
// base por un estado completo y coherente del sistema.

export const SCENARIOS = ['first-run', 'active', 'shielded', 'offline', 'replays', 'real', 'real-floor'] as const
export type ScenarioName = (typeof SCENARIOS)[number]

export const DEFAULT_SEED = 20261031

export interface ScenarioOptions {
  seed: number
  now: number
  // Email del dueño: autor de los cambios de ajustes.
  ownerEmail: string
}

export function isScenario(name: string): name is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(name)
}

// El último latido del bot vivo es de hace 5 s (escribe el snapshot cada 5 s y el
// latido cada 10 s); "offline" es un bot que dejó de escribir hace 12 minutos.
const ALIVE_LAG_MS = 5 * SECOND_MS
const OFFLINE_LAG_MS = 12 * MINUTE_MS

interface LiveDatasetInput {
  spec: (ctx: LiveScenarioContext) => LiveSpec
  lagMs: number
  // Para la pantalla de replays: el terminado se guarda (con las velas de su ventana)
  // junto a los que corren o esperan.
  saveReplays?: boolean
  pending?: DemoSession[]
  // La sesión con plata real junto a la simulación, prendida o apagada por el tope.
  real?: RealVariant
}

function liveDataset(name: ScenarioName, options: ScenarioOptions, { spec, lagMs, pending = [], saveReplays = false, real }: LiveDatasetInput): DemoDataset {
  const botSeenAt = options.now - lagMs
  const ctx = { botSeenAt, ownerEmail: options.ownerEmail }
  const live = spec(ctx)
  const alsoLive = real === undefined ? [] : [realSpec(ctx)]
  const world = buildWorld({ seed: options.seed, botSeenAt, live, replays: finishedReplays(live), saveReplays, alsoLive })
  const realSessions = real === undefined ? [] : world.alsoLive.map((s) => asRealSession(s, real, botSeenAt))
  return {
    scenario: name,
    seed: options.seed,
    now: options.now,
    symbols: COINS.map((c) => ({ row: symbolRow(c), observedSpread: c.halfSpread })),
    candles: world.candles,
    sessions: [world.live, ...realSessions, ...world.replays, ...pending],
    ...(real === undefined ? {} : { readiness: realReadiness(real, botSeenAt) }),
  }
}

// El replay terminado corrió antes de arrancar la simulación en vivo; está en la
// historia del mercado de todos los escenarios en vivo, aunque sólo `replays` lo guarde.
function finishedReplays(live: LiveSpec): FinishedReplaySpec[] {
  return [{ id: 'rep_demo_90d', name: 'Replay 90 días', runAt: live.startedAt - 20 * HOUR_MS, params: { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: true } }]
}

function pendingReplays(now: number): DemoSession[] {
  return [
    buildPendingReplay({
      id: 'rep_demo_corriendo',
      name: 'Replay 90 días con lo aprendido',
      requestedAt: now - 7 * MINUTE_MS,
      params: { days: 90, capital: 1000, learningOrigin: 'current', paramTuning: true },
      status: 'simulando',
      progreso: 41 / 90,
      mensaje: 'Simulando · día 41 de 90',
    }),
    buildPendingReplay({
      id: 'rep_demo_en_cola',
      name: 'Replay 30 días con US$ 2.000',
      requestedAt: now - 1 * MINUTE_MS,
      params: { days: 30, capital: 2000, learningOrigin: 'zero', paramTuning: true },
      status: 'en_cola',
      progreso: 0,
      mensaje: null,
    }),
  ]
}

export function buildDataset(name: ScenarioName, options: ScenarioOptions): DemoDataset {
  switch (name) {
    case 'first-run':
      return { scenario: name, seed: options.seed, now: options.now, symbols: [], candles: [], sessions: [] }
    case 'active':
      return liveDataset(name, options, { spec: activeSpec, lagMs: ALIVE_LAG_MS })
    case 'shielded':
      return liveDataset(name, options, { spec: shieldedSpec, lagMs: ALIVE_LAG_MS })
    case 'offline':
      return liveDataset(name, options, { spec: activeSpec, lagMs: OFFLINE_LAG_MS })
    case 'replays':
      return liveDataset(name, options, { spec: activeSpec, lagMs: ALIVE_LAG_MS, pending: pendingReplays(options.now), saveReplays: true })
    case 'real':
      return liveDataset(name, options, { spec: activeSpec, lagMs: ALIVE_LAG_MS, real: 'on' })
    case 'real-floor':
      return liveDataset(name, options, { spec: activeSpec, lagMs: ALIVE_LAG_MS, real: 'loss_floor' })
  }
}
