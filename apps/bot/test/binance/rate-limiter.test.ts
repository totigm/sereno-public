import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RateLimiter } from '../../src/binance/rate-limiter'

const LIMITS = { weightPerMinute: 2400, dataRequestsPer5m: 1000, fundingRequestsPer5m: 500 }

// Observa si una promesa ya se resolvió sin esperarla (para afirmar "sigue frenada").
function track(p: Promise<unknown>): { settled: boolean } {
  const state = { settled: false }
  void p.then(() => {
    state.settled = true
  })
  return state
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-31T00:00:30.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deja pasar 240 llamadas de peso 10 y frena la 241 hasta que pasa el minuto', async () => {
    const limiter = new RateLimiter(LIMITS)
    const first240 = Array.from({ length: 240 }, () => track(limiter.acquire('weight', 10)))
    await flushMicrotasks()
    expect(first240.every((s) => s.settled)).toBe(true)
    expect(limiter.used('weight')).toBe(2400)

    const blocked = track(limiter.acquire('weight', 10))
    await vi.advanceTimersByTimeAsync(59_999)
    await flushMicrotasks()
    expect(blocked.settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(blocked.settled).toBe(true)
    expect(limiter.used('weight')).toBe(10)
  })

  it('con X-MBX-USED-WEIGHT-1M en 2395 frena hasta el próximo minuto del reloj', async () => {
    const limiter = new RateLimiter(LIMITS)
    limiter.observeHeader(2395)
    expect(limiter.used('weight')).toBe(2395)

    const blocked = track(limiter.acquire('weight', 10))
    // Son las 00:00:30; la ventana de Binance se reinicia a las 00:01:00.
    await vi.advanceTimersByTimeAsync(29_999)
    await flushMicrotasks()
    expect(blocked.settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(blocked.settled).toBe(true)
  })

  it('un header alto deja de contar al cambiar el minuto del reloj: no frena para siempre', async () => {
    const limiter = new RateLimiter(LIMITS)
    limiter.observeHeader(2395)
    expect(limiter.used('weight')).toBe(2395)
    // 00:01:00: Binance reinició su contador; queda sólo lo contado localmente (nada).
    await vi.advanceTimersByTimeAsync(30_000)
    expect(limiter.used('weight')).toBe(0)
    const calls = Array.from({ length: 239 }, () => track(limiter.acquire('weight', 10)))
    await flushMicrotasks()
    expect(calls.every((c) => c.settled)).toBe(true)
    expect(limiter.used('weight')).toBe(2390)
  })

  it('el header no descuenta lo que ya se contó localmente ni ignora lo enviado después', async () => {
    const limiter = new RateLimiter(LIMITS)
    await limiter.acquire('weight', 100)
    limiter.observeHeader(50) // Binance contó menos que nosotros: manda lo local (conservador)
    expect(limiter.used('weight')).toBe(100)

    limiter.observeHeader(300) // otro proceso en la misma IP gastó peso
    await limiter.acquire('weight', 10)
    expect(limiter.used('weight')).toBe(310)
  })

  it('acepta 1000 llamadas a /futures/data por 5 minutos y frena la 1001', async () => {
    const limiter = new RateLimiter(LIMITS)
    for (let i = 0; i < 1000; i++) await limiter.acquire('data', 0)
    const blocked = track(limiter.acquire('data', 0))
    await vi.advanceTimersByTimeAsync(299_999)
    await flushMicrotasks()
    expect(blocked.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(blocked.settled).toBe(true)
  })

  it('fundingRate y fundingInfo comparten 500 llamadas por 5 minutos', async () => {
    const limiter = new RateLimiter(LIMITS)
    for (let i = 0; i < 500; i++) await limiter.acquire('funding', 0)
    const blocked = track(limiter.acquire('funding', 0))
    await flushMicrotasks()
    expect(blocked.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(300_000)
    await flushMicrotasks()
    expect(blocked.settled).toBe(true)
  })

  it('las llamadas frenadas salen en orden de llegada', async () => {
    const limiter = new RateLimiter({ ...LIMITS, weightPerMinute: 20 })
    await limiter.acquire('weight', 20)
    const order: string[] = []
    void limiter.acquire('weight', 10).then(() => order.push('a'))
    void limiter.acquire('weight', 10).then(() => order.push('b'))
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()
    expect(order).toEqual(['a', 'b'])
  })

  it('las de prioridad alta pasan antes que las normales en espera', async () => {
    const limiter = new RateLimiter({ ...LIMITS, weightPerMinute: 20 })
    await limiter.acquire('weight', 20)
    const order: string[] = []
    void limiter.acquire('weight', 10).then(() => order.push('normal-1'))
    void limiter.acquire('weight', 10).then(() => order.push('normal-2'))
    void limiter.acquire('weight', 10, 'high').then(() => order.push('alta-1'))
    void limiter.acquire('weight', 10, 'high').then(() => order.push('alta-2'))
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()
    // Entran dos de diez por minuto: primero las dos altas, en su orden de llegada.
    expect(order).toEqual(['alta-1', 'alta-2'])
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()
    expect(order).toEqual(['alta-1', 'alta-2', 'normal-1', 'normal-2'])
  })

  it('una alta pasa en el acto si hay lugar aunque una normal espere otra clase', async () => {
    const limiter = new RateLimiter({ ...LIMITS, dataRequestsPer5m: 1 })
    await limiter.acquire('data', 0)
    const data = track(limiter.acquire('data', 0))
    const high = track(limiter.acquire('weight', 1, 'high'))
    await flushMicrotasks()
    expect(high.settled).toBe(true)
    expect(data.settled).toBe(false)
  })

  it('holdUntil frena todas las clases hasta la hora indicada', async () => {
    const limiter = new RateLimiter(LIMITS)
    limiter.holdUntil(Date.now() + 5_000)
    const w = track(limiter.acquire('weight', 1))
    const d = track(limiter.acquire('data', 0))
    await vi.advanceTimersByTimeAsync(4_999)
    await flushMicrotasks()
    expect(w.settled).toBe(false)
    expect(d.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(w.settled).toBe(true)
    expect(d.settled).toBe(true)
  })

  it('rechaza un peso mayor que el límite en vez de esperar para siempre', async () => {
    const limiter = new RateLimiter(LIMITS)
    await expect(limiter.acquire('weight', 2401)).rejects.toThrow(/2401/)
  })
})
