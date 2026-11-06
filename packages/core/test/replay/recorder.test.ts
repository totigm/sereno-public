import { describe, expect, it } from 'vitest'
import { ReplayRecorder } from '../../src/replay/recorder'
import type { EngineEvent } from '../../src/types'

const AT = Date.UTC(2026, 9, 5, 12, 0, 0)

function recorder(): ReplayRecorder {
  return new ReplayRecorder({ keepDecisions: true, onDecision: () => undefined })
}

function drawdown(data: unknown, at = AT): EngineEvent {
  return { type: 'account_rule', at, rule: 'drawdown', phrase: 'Pausé: el drawdown llegó al máximo.', data }
}

describe('ReplayRecorder — pausa por drawdown', () => {
  it('guarda la primera pausa de lo real con su pico y equity', () => {
    const r = recorder()
    r.event(drawdown({ peak: 1_000, equity: 790 }))
    r.event(drawdown({ peak: 1_000, equity: 700 }, AT + 1))
    expect(r.drawdownPause).toEqual({ at: AT, peak: 1_000, equity: 790 })
    expect(r.failures).toEqual([])
  })

  it('un aviso sin pico o equity no lanza dentro del sink: queda como falla y sin pausa', () => {
    const r = recorder()
    expect(() => r.event(drawdown({ peak: 1_000 }))).not.toThrow()
    expect(r.drawdownPause).toBeNull()
    expect(r.failures).toEqual([{ operation: 'event', event: 'account_rule', at: AT, error: 'aviso de drawdown sin pico o equity: {"peak":1000}' }])
    // Uno bueno después todavía se registra.
    r.event(drawdown({ peak: 1_000, equity: 790 }, AT + 1))
    expect(r.drawdownPause).toEqual({ at: AT + 1, peak: 1_000, equity: 790 })
  })
})
