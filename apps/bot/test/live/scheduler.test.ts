import { describe, expect, it } from 'vitest'
import { DAY_MS, Scheduler, WEEK_SUNDAY_0030_OFFSET_MS, nextRun } from '../../src/live/scheduler'
import { ManualClock } from '../helpers/manual-clock'

const T0 = Date.UTC(2026, 9, 31, 11, 50, 0)

describe('nextRun', () => {
  it('da el próximo instante alineado al período, estrictamente después de ahora', () => {
    expect(nextRun(T0, 15 * 60_000)).toBe(Date.UTC(2026, 9, 31, 12, 0, 0))
    expect(nextRun(Date.UTC(2026, 9, 31, 12, 0, 0), 15 * 60_000)).toBe(Date.UTC(2026, 9, 31, 12, 15, 0))
    expect(nextRun(T0, DAY_MS, 5 * 60_000)).toBe(Date.UTC(2026, 10, 1, 0, 5, 0))
  })

  it('el semanal cae los domingos a las 00:30 UTC', () => {
    const at = nextRun(T0, 7 * DAY_MS, WEEK_SUNDAY_0030_OFFSET_MS)
    expect(new Date(at).toISOString()).toBe('2026-11-01T00:30:00.000Z')
    expect(new Date(at).getUTCDay()).toBe(0)
  })
})

describe('Scheduler', () => {
  it('corre cada trabajo en sus instantes alineados', async () => {
    const clock = new ManualClock(T0)
    const runs: number[] = []
    const scheduler = new Scheduler({ clock, onError: () => {} })
    scheduler.add({ name: 'cada-10s', period: 10_000, run: async (at) => void runs.push(at) })
    await clock.advance(30_000)
    expect(runs).toEqual([T0 + 10_000, T0 + 20_000, T0 + 30_000])
    scheduler.stop()
    await clock.advance(30_000)
    expect(runs).toHaveLength(3)
  })

  it('no superpone dos corridas del mismo trabajo y sigue después de un error', async () => {
    const clock = new ManualClock(T0)
    const errors: string[] = []
    let release: () => void = () => {}
    let calls = 0
    const scheduler = new Scheduler({ clock, onError: (name) => errors.push(name) })
    scheduler.add({
      name: 'lento',
      period: 1_000,
      run: () => {
        calls += 1
        if (calls === 1) return new Promise<void>((resolve) => (release = resolve))
        if (calls === 2) return Promise.reject(new Error('falló'))
        return Promise.resolve()
      },
    })
    await clock.advance(3_000)
    expect(calls).toBe(1)
    release()
    await clock.advance(2_000)
    expect(calls).toBe(3)
    expect(errors).toEqual(['lento'])
    scheduler.stop()
  })
})
