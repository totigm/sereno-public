import { describe, expect, it } from 'vitest'
import { forEachLimit } from '../../src/jobs/pool'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('forEachLimit', () => {
  it('nunca tiene más de `concurrency` tareas en vuelo y las recorre todas en orden de salida', async () => {
    let inFlight = 0
    let peak = 0
    const started: number[] = []
    await forEachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      started.push(n)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5 - (n % 3)))
      inFlight--
    })
    expect(peak).toBe(3)
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('ante un error deja de largar tareas, espera las que están en vuelo y lo propaga', async () => {
    const slow = deferred()
    const started: number[] = []
    let slowFinished = false
    const run = forEachLimit([1, 2, 3, 4], 2, async (n) => {
      started.push(n)
      if (n === 1) {
        await slow.promise
        slowFinished = true
      }
      if (n === 2) throw new Error('falló 2')
    })
    let settled = false
    void run.catch(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    slow.resolve()
    await expect(run).rejects.toThrow('falló 2')
    expect(slowFinished).toBe(true)
    expect(started).toEqual([1, 2])
  })

  it('rechaza una concurrencia inválida', async () => {
    await expect(forEachLimit([1], 0, async () => {})).rejects.toThrow(RangeError)
  })
})
