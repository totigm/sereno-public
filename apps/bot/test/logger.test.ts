import { describe, it, expect } from 'vitest'
import { createLogger } from '../src/logger'
import { logSink as sink } from './helpers/log-sink'

describe('createLogger', () => {
  it('escribe JSON por línea con nivel, nombre y los campos del evento', () => {
    const out = sink()
    const logger = createLogger({ level: 'info', destination: out.stream })
    logger.info({ symbol: 'BTCUSDT' }, 'vela cerrada')
    logger.debug('esto no sale')
    const [line] = out.lines()
    expect(line).toMatchObject({ level: 30, name: 'sereno', symbol: 'BTCUSDT', msg: 'vela cerrada' })
    expect(out.lines()).toHaveLength(1)
  })

  it('respeta el nivel pedido', () => {
    const out = sink()
    const logger = createLogger({ level: 'debug', destination: out.stream })
    logger.debug('ahora sí')
    expect(out.lines()[0]).toMatchObject({ level: 20, msg: 'ahora sí' })
  })
})
