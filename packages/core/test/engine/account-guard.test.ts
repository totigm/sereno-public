import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { AccountGuard, initialGuardState } from '../../src/engine/account-guard'
import { accountRules } from '../../src/risk/account-rules'
import type { CloseReason, ClosedPosition } from '../../src/types'
import { makeClosed } from '../learning/fixtures'

const MIN = 60_000
const HOUR = 60 * MIN
const SETTINGS = { risk: DEFAULT_SETTINGS.risk, entry: DEFAULT_SETTINGS.entry }
// 31 de octubre de 2026, 10:00 en Buenos Aires (13:00 UTC).
const T0 = Date.UTC(2026, 9, 31, 13)

function closed(reason: CloseReason, at: number, pnlNet = -10, symbol = 'SOLUSDT'): ClosedPosition {
  return { ...makeClosed({ symbol, closedAt: at, rMultiple: pnlNet / 10 }), closeReason: reason, pnlNet }
}

function evaluate(guard: AccountGuard, now: number, equity: number | null = 1_000, capitalBase = 1_000) {
  return guard.evaluate({ now, capitalBase, equity, settings: SETTINGS })
}

describe('AccountGuard — pérdida diaria con el día de Buenos Aires', () => {
  it('suma lo realizado desde las 00:00 de Buenos Aires, aunque el día UTC ya haya cambiado', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    guard.noteRealized(-20, Date.UTC(2026, 9, 31, 15))
    // 23:30 del 31 en Buenos Aires = 02:30 UTC del 1 de noviembre.
    guard.noteRealized(-15, Date.UTC(2026, 10, 1, 2, 30))
    const result = evaluate(guard, Date.UTC(2026, 10, 1, 2, 45))
    expect(result.blocked).toBe('daily_loss')
    expect(result.triggers).toEqual([{ rule: 'daily_loss', data: { todayRealized: -35, limitPct: 0.03 } }])
  })

  it('avisa una sola vez por día y a las 00:00 de Buenos Aires vuelve a cero', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    guard.noteRealized(-35, Date.UTC(2026, 9, 31, 15))
    expect(evaluate(guard, Date.UTC(2026, 9, 31, 16)).triggers).toHaveLength(1)
    const again = evaluate(guard, Date.UTC(2026, 10, 1, 2, 59))
    expect(again).toEqual({ blocked: 'daily_loss', triggers: [] })
    expect(evaluate(guard, Date.UTC(2026, 10, 1, 3))).toEqual({ blocked: null, triggers: [] })
    expect(guard.snapshot().dayRealized).toBe(0)
  })
})

describe('AccountGuard — racha y enfriamientos', () => {
  it('6 stops seguidos ⇒ 4 horas sin entradas, con el contador de racha reiniciado', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    for (let i = 0; i < 6; i++) guard.noteClose(closed('stop', T0 + i * 20 * MIN), SETTINGS.entry)
    const now = T0 + 2 * HOUR
    const result = evaluate(guard, now)
    expect(result).toEqual({ blocked: 'streak_pause', triggers: [{ rule: 'streak', data: { stops: 6, until: now + 4 * HOUR } }] })
    expect(guard.snapshot().consecutiveStops).toBe(0)
    expect(evaluate(guard, now + 4 * HOUR - 1)).toEqual({ blocked: 'streak_pause', triggers: [] })
    expect(evaluate(guard, now + 4 * HOUR)).toEqual({ blocked: null, triggers: [] })
  })

  it('una salida de estrategia corta la racha; un cierre manual no', () => {
    const cut = new AccountGuard(initialGuardState(T0))
    const kept = new AccountGuard(initialGuardState(T0))
    for (let i = 0; i < 5; i++) {
      cut.noteClose(closed('stop', T0 + i * 2 * HOUR), SETTINGS.entry)
      kept.noteClose(closed('stop', T0 + i * 2 * HOUR), SETTINGS.entry)
    }
    cut.noteClose(closed('take_profit', T0 + 10 * HOUR, 20), SETTINGS.entry)
    kept.noteClose(closed('manual', T0 + 10 * HOUR, -3), SETTINGS.entry)
    cut.noteClose(closed('liquidation', T0 + 12 * HOUR), SETTINGS.entry)
    kept.noteClose(closed('liquidation', T0 + 12 * HOUR), SETTINGS.entry)
    expect(evaluate(cut, T0 + 14 * HOUR).blocked).toBeNull()
    expect(evaluate(kept, T0 + 14 * HOUR).blocked).toBe('streak_pause')
  })

  it('3 stops en la misma hora ⇒ 2 velas sin entradas, con el motivo que da accountRules', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    for (let i = 0; i < 3; i++) guard.noteClose(closed('stop', T0 + i * 10 * MIN, -10, `C${i}USDT`), SETTINGS.entry)
    const now = T0 + 30 * MIN
    const expected = accountRules({ capitalBase: 1_000, todayRealized: 0, equityPeak: 1_000, equity: 1_000, consecutiveStops: 0, stopsLastHour: 3, now, settings: SETTINGS })
    expect(evaluate(guard, now)).toEqual({ blocked: expected.blocked, triggers: [] })
    expect(evaluate(guard, now + 30 * MIN - 1).blocked).toBe(expected.blocked)
    // Los stops que dispararon el enfriamiento no lo vuelven a disparar.
    expect(evaluate(guard, now + 30 * MIN).blocked).toBeNull()
  })

  it('después de una pérdida la moneda queda 4 velas en enfriamiento; después de una ganancia no', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    guard.noteClose(closed('stop', T0, -5, 'SOLUSDT'), SETTINGS.entry)
    guard.noteClose(closed('take_profit', T0, 12, 'ETHUSDT'), SETTINGS.entry)
    expect(guard.inCooldown('SOLUSDT', T0 + 60 * MIN - 1)).toBe(true)
    expect(guard.inCooldown('SOLUSDT', T0 + 60 * MIN)).toBe(false)
    expect(guard.inCooldown('ETHUSDT', T0 + MIN)).toBe(false)
  })
})

describe('AccountGuard — drawdown', () => {
  it('15% desde el pico ⇒ pausa que sigue aunque el equity se recupere, hasta que Toti reanuda', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    expect(evaluate(guard, T0, 1_000).blocked).toBeNull()
    expect(evaluate(guard, T0 + HOUR, 849)).toEqual({ blocked: 'drawdown_pause', triggers: [{ rule: 'drawdown', data: { peak: 1_000, equity: 849 } }] })
    expect(evaluate(guard, T0 + 2 * HOUR, 1_000)).toEqual({ blocked: 'drawdown_pause', triggers: [] })
    guard.resume()
    // El pico se vuelve a medir desde la reanudación.
    expect(evaluate(guard, T0 + 3 * HOUR, 900).blocked).toBeNull()
    expect(evaluate(guard, T0 + 4 * HOUR, 800).blocked).toBeNull()
    expect(evaluate(guard, T0 + 5 * HOUR, 760).blocked).toBe('drawdown_pause')
  })

  it('reanudar sin pausa por drawdown conserva el pico: una pausa manual no afloja el corte', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    evaluate(guard, T0, 1_200)
    expect(evaluate(guard, T0 + HOUR, 1_080).blocked).toBeNull()
    guard.resume()
    // 1.000 está 16,7% abajo del pico real de 1.200: el corte del 15% sigue en pie.
    expect(evaluate(guard, T0 + 2 * HOUR, 1_000)).toEqual({ blocked: 'drawdown_pause', triggers: [{ rule: 'drawdown', data: { peak: 1_200, equity: 1_000 } }] })
  })

  it('sombra (drawdown "rebase"): avisa y vuelve a medir el pico desde ahí, sin pausar', () => {
    const guard = new AccountGuard(initialGuardState(T0), { drawdown: 'rebase' })
    evaluate(guard, T0, 1_000)
    expect(evaluate(guard, T0 + HOUR, 849)).toEqual({ blocked: null, triggers: [{ rule: 'drawdown', data: { peak: 1_000, equity: 849 } }] })
    expect(guard.snapshot()).toMatchObject({ drawdownPaused: false, equityPeak: 849 })
    // El próximo aviso llega recién con otro 15% desde el pico nuevo (849 × 0,85 = 721,65).
    expect(evaluate(guard, T0 + 2 * HOUR, 730)).toEqual({ blocked: null, triggers: [] })
    expect(evaluate(guard, T0 + 3 * HOUR, 721)).toEqual({ blocked: null, triggers: [{ rule: 'drawdown', data: { peak: 849, equity: 721 } }] })
  })

  it('sin todas las marcas (equity null) no mueve el pico ni dispara el drawdown', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    evaluate(guard, T0, 1_000)
    expect(evaluate(guard, T0 + HOUR, null).blocked).toBeNull()
    expect(guard.snapshot().equityPeak).toBe(1_000)
  })
})

describe('AccountGuard — estado persistible', () => {
  it('una guarda reconstruida desde el snapshot sigue con las mismas pausas', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    for (let i = 0; i < 6; i++) guard.noteClose(closed('stop', T0 + i * 20 * MIN), SETTINGS.entry)
    evaluate(guard, T0 + 2 * HOUR)
    const restored = new AccountGuard(JSON.parse(JSON.stringify(guard.snapshot())))
    expect(restored.snapshot()).toEqual(guard.snapshot())
    expect(evaluate(restored, T0 + 3 * HOUR).blocked).toBe('streak_pause')
  })

  it('el snapshot es una copia: modificarlo no cambia la guarda', () => {
    const guard = new AccountGuard(initialGuardState(T0))
    guard.noteClose(closed('stop', T0, -5), SETTINGS.entry)
    const copy = guard.snapshot()
    copy.cooldownUntil['SOLUSDT'] = 0
    expect(guard.inCooldown('SOLUSDT', T0 + MIN)).toBe(true)
  })
})
