import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ControlLedger } from '../../src/binance/control-ledger'

describe('ControlLedger', () => {
  let ready: number
  let ledger: ControlLedger

  beforeEach(() => {
    vi.useFakeTimers()
    ready = 0
    ledger = new ControlLedger({ retryBaseMs: 1_000, maxRetries: 3, onRetryReady: () => ready++ })
  })
  afterEach(() => {
    ledger.dispose()
    vi.useRealTimers()
  })

  it('una respuesta a un id que no espera nada es desconocida, también la segunda al mismo id', () => {
    expect(ledger.answer(7, true)).toEqual({ kind: 'unknown' })
    ledger.sent(1, { method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 0 })
    expect(ledger.answer(1, false)).toEqual({ kind: 'accepted' })
    expect(ledger.answer(1, true)).toEqual({ kind: 'unknown' })
  })

  it('el reintento queda listo al vencer la espera y nextRetry lo filtra sin sacarlo', () => {
    ledger.sent(1, { method: 'SUBSCRIBE', symbols: ['SOLUSDT', 'XRPUSDT'], retries: 0 })
    expect(ledger.answer(1, true)).toMatchObject({ kind: 'retrying', delayMs: 1_000 })
    expect(ledger.nextRetry(() => true)).toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(ready).toBe(1)
    const wantsSol = (s: string): boolean => s === 'SOLUSDT'
    expect(ledger.nextRetry(wantsSol)).toEqual({ method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 1 })
    expect(ledger.nextRetry(wantsSol)).not.toBeNull()
    ledger.dropRetry()
    expect(ledger.nextRetry(wantsSol)).toBeNull()
  })

  it('pasado el último reintento el lote falla', () => {
    ledger.sent(4, { method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 3 })
    expect(ledger.answer(4, true)).toEqual({ kind: 'failed', control: { method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 3 } })
  })

  it('supersede saca las monedas de un SUBSCRIBE nuevo de los reintentos en espera y de los listos', () => {
    ledger.sent(1, { method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 0 })
    ledger.sent(2, { method: 'SUBSCRIBE', symbols: ['XRPUSDT', 'ADAUSDT'], retries: 0 })
    ledger.answer(1, true)
    vi.advanceTimersByTime(1_000)
    ledger.answer(2, true)
    ledger.supersede(['SOLUSDT', 'XRPUSDT'])
    // El listo de SOL quedó vacío y se fue; el de XRP y ADA sigue en espera sólo con ADA.
    expect(ledger.nextRetry(() => true)).toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(ready).toBe(2)
    expect(ledger.nextRetry(() => true)).toEqual({ method: 'SUBSCRIBE', symbols: ['ADAUSDT'], retries: 1 })
  })

  it('un reintento en espera que se queda sin monedas no avisa que está listo', () => {
    ledger.sent(1, { method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 0 })
    ledger.answer(1, true)
    ledger.supersede(['SOLUSDT'])
    vi.advanceTimersByTime(60_000)
    expect(ready).toBe(0)
    expect(ledger.nextRetry(() => true)).toBeNull()
  })

  it('un SUBSCRIBE sin respuesta cuyas monedas salieron en uno nuevo no se reintenta al rechazarse', () => {
    ledger.sent(1, { method: 'SUBSCRIBE', symbols: ['SOLUSDT', 'XRPUSDT'], retries: 0 })
    ledger.sent(2, { method: 'SUBSCRIBE', symbols: ['ADAUSDT'], retries: 0 })
    ledger.sent(3, { method: 'UNSUBSCRIBE', symbols: ['SOLUSDT'], retries: 0 })
    ledger.supersede(['SOLUSDT', 'ADAUSDT'])
    expect(ledger.answer(1, true)).toMatchObject({ kind: 'retrying', control: { symbols: ['XRPUSDT'] } })
    expect(ledger.answer(2, true)).toEqual({ kind: 'superseded' })
    // Un UNSUBSCRIBE no es un lote anterior del SUBSCRIBE: se informa tal cual.
    expect(ledger.answer(3, true)).toMatchObject({ kind: 'unsubscribe_rejected', control: { symbols: ['SOLUSDT'] } })
  })

  it('dispose cancela las esperas y olvida lo enviado', () => {
    ledger.sent(1, { method: 'SUBSCRIBE', symbols: ['SOLUSDT'], retries: 0 })
    ledger.sent(2, { method: 'SUBSCRIBE', symbols: ['XRPUSDT'], retries: 0 })
    ledger.answer(1, true)
    ledger.dispose()
    vi.advanceTimersByTime(60_000)
    expect(ready).toBe(0)
    expect(ledger.nextRetry(() => true)).toBeNull()
    expect(ledger.answer(2, true)).toEqual({ kind: 'unknown' })
  })
})
