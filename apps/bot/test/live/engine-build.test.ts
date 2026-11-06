import { describe, expect, it } from 'vitest'
import type { SymbolInfo } from '@sereno/core'
import { liquidationPrice } from '@sereno/core/src/risk/liquidation'
import { initialLearningState } from '@sereno/core/src/learning/state'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { createLogger } from '../../src/logger'
import { buildEngine, planFromSnapshot } from '../../src/live/engine-build'
import { openPosition, snapshotOf } from '../helpers/engine-fixtures'
import { logSink } from '../helpers/log-sink'

const AT = Date.UTC(2026, 9, 31, 12, 0, 0)

function sol(mmr: number): SymbolInfo {
  return {
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    minNotional: 5,
    minQty: 0.001,
    stepSize: 0.001,
    tickSize: 0.01,
    quantityPrecision: 3,
    mmr,
    liquidationFee: 0.0125,
    fundingIntervalHours: 8,
    halfSpreadRate: 0,
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    onboardDate: 0,
  }
}

describe('buildEngine', () => {
  it('con un mmr nuevo, el motor queda con la liquidación recalculada y lo deja en el log', async () => {
    const before = liquidationPrice('long', 150, 3, 0.01)
    const after = liquidationPrice('long', 150, 3, 0.02)
    const position = openPosition({ id: 'p1', symbol: 'SOLUSDT', liquidationPrice: before })
    const sink = logSink()
    const engine = await buildEngine({
      sessionId: 's1',
      capitalInicial: 1000,
      settings: DEFAULT_SETTINGS,
      learning: initialLearningState(AT),
      plan: planFromSnapshot(snapshotOf({ at: AT, positions: [position] })),
      infos: { SOLUSDT: sol(0.02) },
      clock: () => AT,
      sink: () => undefined,
      onFailure: () => undefined,
      logger: createLogger({ destination: sink.stream }),
    })
    expect(engine.snapshot().real.positions[0]?.position.liquidationPrice).toBe(after)
    expect(sink.lines()).toEqual([
      expect.objectContaining({
        level: 30,
        sessionId: 's1',
        positionId: 'p1',
        from: before,
        to: after,
        msg: 'Binance cambió el margen de mantenimiento de SOL: la liquidación del long pasa de 101,01 a 102,04.',
      }),
    ])
  })

  it('si la liquidación guardada vale, no escribe nada', async () => {
    const position = openPosition({ id: 'p1', symbol: 'SOLUSDT', liquidationPrice: liquidationPrice('long', 150, 3, 0.02) })
    const sink = logSink()
    await buildEngine({
      sessionId: 's1',
      capitalInicial: 1000,
      settings: DEFAULT_SETTINGS,
      learning: initialLearningState(AT),
      plan: planFromSnapshot(snapshotOf({ at: AT, positions: [position] })),
      infos: { SOLUSDT: sol(0.02) },
      clock: () => AT,
      sink: () => undefined,
      onFailure: () => undefined,
      logger: createLogger({ destination: sink.stream }),
    })
    expect(sink.lines()).toEqual([])
  })
})
