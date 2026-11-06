import { REAL_CHECK_IDS, type RealCheck } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { canCreateReal, readinessMissing, type ReadinessView } from '@/lib/real-readiness'

const allOk = (): RealCheck[] => REAL_CHECK_IDS.map((id) => ({ id, status: 'ok', detail: '' }))

function view(patch: Partial<ReadinessView> = {}): ReadinessView {
  return { env: 'testnet', enabled: true, keysPresent: true, checks: allOk(), checkedAt: 0, stale: false, walletAvailable: 120, ...patch }
}

describe('qué falta para la plata real', () => {
  it('con todo en verde y la billetera leída, se puede crear', () => {
    expect(canCreateReal(view(), null)).toEqual({ ok: true })
  })

  it('sin la billetera leída no se puede crear: no hay contra qué medir el capital', () => {
    expect(canCreateReal(view({ walletAvailable: null }), null)).toEqual({ ok: false, missing: ['Que el bot lea la billetera de futuros'] })
  })

  it('prender una que ya existe no depende de la lectura de la billetera, sino de su chequeo', () => {
    expect(readinessMissing(view({ walletAvailable: null }), { newSession: false })).toEqual([])
    const failing = allOk().map((c) => (c.id === 'wallet' ? { ...c, status: 'fail' as const } : c))
    expect(readinessMissing(view({ checks: failing }), { newSession: false })).toEqual(['La billetera de futuros tiene el capital asignado'])
  })

  it('con la real anterior apagada pero con abiertas, no se puede empezar otra', () => {
    expect(canCreateReal(view(), { status: 'off', openPositions: 2 })).toEqual({
      ok: false,
      missing: ['Que se cierren las posiciones abiertas de la sesión con plata real anterior'],
    })
    expect(canCreateReal(view(), { status: 'loss_floor', openPositions: 0 })).toEqual({ ok: true })
  })
})
