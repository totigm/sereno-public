import type { EngineEvent, Position } from '@sereno/core'
import { initialGuardState } from '@sereno/core/src/engine/account-guard'
import type { TradingEngine } from '@sereno/core/src/engine/engine'
import { initialLearningState } from '@sereno/core/src/learning/state'
import { liquidationPrice } from '@sereno/core/src/risk/liquidation'
import type { SessionRow } from '@sereno/db'
import { REAL_CHECK_IDS, type RealCheck, type Settings } from '@sereno/shared'
import type { FakeBinance } from '../../src/binance/fake/server'
import { UserDataStream } from '../../src/binance/user-stream'
import { silentLogger } from '../../src/logger'
import { liveIdPrefix, planFromSnapshot } from '../../src/live/engine-build'
import type { EngineLane } from '../../src/live/engine-lane'
import { RecentErrors } from '../../src/live/heartbeat'
import { RealController } from '../../src/real/controller'
import { buildRealKit, type RealKit } from '../../src/real/kit'
import { restFor, tradeFor } from './binance'
import type { TestDb } from './db'
import { ManualClock } from './manual-clock'
import { fixedScorer, markTick, REAL_INFOS, REAL_T0, realView } from './real'

// La sesión real sin el `LiveSession` alrededor: el kit contra el Binance falso, el
// controlador y un carril que hace lo mismo que el de la sesión con los eventos del motor.

export const ALL_OK: RealCheck[] = REAL_CHECK_IDS.map((id) => ({ id, status: 'ok', detail: '' }))
const ETH = 'ETHUSDT'

// El carril de `LiveSession` en chico: la operación, lo que agrega el controlador con sus
// eventos y las escrituras extra, contra la base de prueba.
export class TestLane implements EngineLane {
  engine: TradingEngine | null = null
  readonly events: EngineEvent[] = []
  controller: RealController | null = null

  constructor(private readonly t: TestDb) {}

  async run<T>(op: (engine: TradingEngine) => Promise<T>, extra?: (result: T) => ((repos: TestDb['repos']) => Promise<void>) | undefined): Promise<T> {
    const result = await op(this.requireEngine())
    const events = this.events.splice(0)
    const added = events.length > 0 ? await this.controller?.afterOp(events) : undefined
    await extra?.(result)?.(this.t.repos)
    await added?.(this.t.repos)
    return result
  }

  snapshot() {
    return this.requireEngine().snapshot()
  }

  private requireEngine(): TradingEngine {
    if (!this.engine) throw new Error('sin motor')
    return this.engine
  }
}

export interface RealSessionRig {
  clock: ManualClock
  kit: RealKit
  lane: TestLane
  controller: RealController
  errors: RecentErrors
}

// Una sesión `live` activa nueva (archiva la anterior).
export async function createRealSession(t: TestDb, lossCap = 0.5): Promise<SessionRow> {
  await t.query(`update sessions set status = 'archived', ended_at = now() where status = 'active' and kind = 'live'`)
  return t.repos.sessions.createReal({ capitalInicial: 1_000, lossCap, binanceEnv: 'mainnet' })
}

// `open` deja en Binance lo que un proceso anterior ya tenía y devuelve esas abiertas para restaurar.
export async function realSessionRig(
  t: TestDb,
  fake: FakeBinance,
  session: SessionRow,
  settings: Settings,
  open: (kit: RealKit) => Promise<Position[]> = async () => [],
): Promise<RealSessionRig> {
  const clock = new ManualClock(REAL_T0)
  fake.now = clock.now
  const { trade } = tradeFor(fake)
  const lane = new TestLane(t)
  const errors = new RecentErrors()
  const kit = await buildRealKit({
    sessionId: session.id,
    trade,
    userStream: new UserDataStream({ trade, url: fake.userWsUrl, clock, backoffBaseMs: 5, backoffMaxMs: 20 }),
    repos: t.repos,
    rest: restFor(fake, clock.now).rest,
    clock,
    logger: silentLogger,
    openings: () => controller.openings(),
    onNote: (note) => controller.note(note),
    retry: { delaysMs: [0], fillTimeoutMs: 500 },
  })
  const controller = new RealController({
    repos: t.repos,
    sessionId: session.id,
    binanceEnv: 'mainnet',
    realStatus: 'on',
    realChangedAt: session.realChangedAt?.getTime() ?? null,
    kit,
    lane,
    clock,
    logger: silentLogger,
    config: { enabled: true, env: 'mainnet' },
    readiness: { latest: ALL_OK, run: async () => ALL_OK },
    errors,
  })
  lane.controller = controller
  const positions = await open(kit)
  const account = { saldo: 1_000, protegido: 0, baseBlindaje: 1_000 }
  lane.engine = await kit.buildEngine({
    sessionId: session.id,
    capitalInicial: 1_000,
    settings,
    learning: initialLearningState(REAL_T0),
    plan: {
      state: { real: { positions: positions.map((position) => ({ position, entryCosts: { spread: 0, slippage: 0 }, tickSize: 0.01 })), guard: initialGuardState(REAL_T0) }, shadow: null, waitedAt: {} },
      real: account,
      shadow: account,
    },
    infos: REAL_INFOS,
    clock: clock.now,
    sink: (e) => lane.events.push(e),
    onFailure: () => undefined,
    logger: silentLogger,
    scorer: fixedScorer({ [ETH]: 0.9 }),
  })
  return { clock, kit, lane, controller, errors }
}

// Rehace el motor como `LiveSession` cuando cambian los ajustes de riesgo o los contratos: el
// plan sale del snapshot del motor vigente. Si no se puede, sigue el anterior.
export async function rebuildEngine(rig: RealSessionRig, sessionId: string, settings: Settings, infos = REAL_INFOS): Promise<void> {
  const snapshot = rig.lane.snapshot()
  rig.lane.engine = await rig.kit.buildEngine({
    sessionId,
    capitalInicial: 1_000,
    settings,
    learning: snapshot.learning,
    plan: planFromSnapshot(snapshot),
    infos,
    clock: rig.clock.now,
    sink: (e) => rig.lane.events.push(e),
    onFailure: () => undefined,
    logger: silentLogger,
    scorer: fixedScorer({ [ETH]: 0.9 }),
  })
}

// El motor abre ETH en el ciclo de las 12:00.
export async function openEth(lane: TestLane): Promise<void> {
  await lane.run(async (engine) => {
    await engine.onMarkTick(markTick(ETH, 2_000, REAL_T0))
    return engine.onCandleClose([realView(ETH, REAL_T0, 2_000, 20)], { missingSymbols: [], degraded: [] })
  })
}

// Una abierta del bot de 0.2 ETH a 2x con el stop lejos, como la dejó un proceso anterior.
export async function wideEth(kit: RealKit, sessionId: string): Promise<Position[]> {
  await kit.trade.setIsolated(ETH)
  await kit.trade.setLeverage(ETH, 2)
  await kit.trade.marketOrder({ symbol: ETH, side: 'BUY', quantity: '0.2', reduceOnly: false, clientOrderId: kit.ids.next('o') })
  return [
    {
      id: `${liveIdPrefix(sessionId)}-real-${ETH}-${REAL_T0}`,
      symbol: ETH,
      side: 'long',
      leverage: 2,
      margin: 200,
      notional: 400,
      qty: 0.2,
      entryPrice: 2_000,
      openedAt: REAL_T0,
      stopPrice: 1_100,
      takeProfitPrice: 3_000,
      liquidationPrice: liquidationPrice('long', 2_000, 2, REAL_INFOS[ETH]!.mmr),
      distanciaStop: 0.45,
      riesgoReal: 180,
      thetaAtOpen: 0.35,
      trailingActive: false,
      bestPrice: 2_000,
      stopOrderId: null,
      tpOrderId: null,
      feesPaid: 0.2,
      fundingPaid: 0,
      shadow: false,
      openReason: 'Abrí un long en ETH.',
      signalsAtOpen: [],
      mode: 'auto',
    },
  ]
}
