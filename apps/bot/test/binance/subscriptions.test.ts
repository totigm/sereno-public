import { describe, it, expect } from 'vitest'
import { nextControlStep } from '../../src/binance/subscriptions'

describe('nextControlStep', () => {
  it('no manda nada si la conexión ya tiene el conjunto deseado', () => {
    expect(nextControlStep(new Set(['BTCUSDT', 'ETHUSDT']), new Set(['ETHUSDT', 'BTCUSDT']))).toBeNull()
  })

  it('pide las altas que faltan en un solo SUBSCRIBE', () => {
    expect(nextControlStep(new Set(['BTCUSDT', 'SOLUSDT', 'XRPUSDT']), new Set(['BTCUSDT']))).toEqual({ method: 'SUBSCRIBE', symbols: ['SOLUSDT', 'XRPUSDT'] })
  })

  it('pide las bajas antes que las altas', () => {
    expect(nextControlStep(new Set(['BTCUSDT', 'SOLUSDT']), new Set(['BTCUSDT', 'ETHUSDT']))).toEqual({ method: 'UNSUBSCRIBE', symbols: ['ETHUSDT'] })
    expect(nextControlStep(new Set(['BTCUSDT', 'SOLUSDT']), new Set(['BTCUSDT']))).toEqual({ method: 'SUBSCRIBE', symbols: ['SOLUSDT'] })
  })
})
