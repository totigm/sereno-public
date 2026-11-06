import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MarketStream, type MarketStreamOptions, type StreamStatus } from '../../src/binance/ws'
import { fakeSocketFactory, type FakeSocket } from '../../src/binance/fake/socket'
import { klineEvent, markPriceEvent } from '../../src/binance/fake/fixtures'

// Ciclo de vida de la conexión contra un socket falso con reloj falso: rotación,
// backoff, vigía de silencio y pong, sin depender de tiempos reales.

const NOW = Date.UTC(2026, 9, 31, 12, 5, 0) // mitad de vela de 15m: lejos de la ventana tranquila
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0)

function mark(symbol: string, at: number): { stream: string; data: unknown } {
  return { stream: `${symbol.toLowerCase()}@markPrice@1s`, data: markPriceEvent({ symbol, markPrice: 100, fundingRate: '0.0001', nextFundingTime: at + 3_600_000, at }) }
}

describe('MarketStream: ciclo de vida de la conexión', () => {
  let sockets: FakeSocket[]
  let stream: MarketStream
  let statuses: StreamStatus[]

  function open(overrides: Partial<MarketStreamOptions> = {}): MarketStream {
    const factory = fakeSocketFactory()
    sockets = factory.sockets
    statuses = []
    stream = new MarketStream({
      url: 'wss://fstream.binance.com/market/stream',
      symbols: ['BTCUSDT'],
      WebSocket: factory.WebSocket,
      now: () => Date.now(),
      // El socket falso no manda nada solo: el vigía de silencio se prueba aparte.
      staleAfterMs: 10 * 60_000,
      ...overrides,
    })
    stream.on('status', (st) => statuses.push(st))
    return stream
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    stream.stop()
    vi.useRealTimers()
  })

  describe('rotación programada', () => {
    it('abre la conexión nueva antes de soltar la vieja, sin cortar datos ni avisar reconnecting', () => {
      const s = open()
      const ticks: number[] = []
      s.on('mark', (t) => ticks.push(t.at))
      s.start()
      sockets[0]!.open()
      s.scheduleReconnectAt(Date.now() + 60_000)
      vi.advanceTimersByTime(60_000)

      const [old, next] = sockets
      expect(sockets).toHaveLength(2)
      expect(next!.streams).toEqual(old!.streams)
      // Mientras la nueva hace el handshake, la vieja sigue entregando datos.
      old!.receive(mark('BTCUSDT', T0))
      next!.open()
      expect(old!.closedBy).toBe('client-close')
      next!.receive(mark('BTCUSDT', T0 + 1_000))
      expect(ticks).toEqual([T0, T0 + 1_000])
      expect(statuses).toEqual(['connected'])
      expect(s.plannedReconnectAt).toBeGreaterThanOrEqual(NOW + 60_000 + 23 * 3_600_000)
    })

    it('si la conexión nueva no abre, sigue la vieja y reintenta la rotación más tarde', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.scheduleReconnectAt(Date.now() + 60_000)
      vi.advanceTimersByTime(60_000)
      sockets[1]!.failHandshake()
      expect(sockets[0]!.readyState).toBe(1)
      expect(statuses).toEqual(['connected'])

      vi.advanceTimersByTime(29_999)
      expect(sockets).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(3)
      sockets[2]!.open()
      expect(sockets[0]!.closedBy).toBe('client-close')
    })

    it('si la vieja se cae durante el handshake de la nueva, la nueva toma su lugar sin abrir una tercera', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.scheduleReconnectAt(Date.now() + 60_000)
      vi.advanceTimersByTime(60_000)
      sockets[0]!.drop()
      expect(statuses).toEqual(['connected', 'reconnecting'])
      vi.advanceTimersByTime(60_000)
      expect(sockets).toHaveLength(2)
      sockets[1]!.open()
      expect(statuses).toEqual(['connected', 'reconnecting', 'connected'])
    })

    it('una rotación que vence durante el backoff no abre un segundo socket', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      sockets[0]!.drop()
      s.scheduleReconnectAt(Date.now() + 10)
      vi.advanceTimersByTime(10)
      expect(sockets).toHaveLength(1)
      vi.advanceTimersByTime(990)
      expect(sockets).toHaveLength(2)
      vi.advanceTimersByTime(60_000)
      expect(sockets).toHaveLength(2)
    })

    it('una rotación que vence durante un handshake no abre un segundo socket', () => {
      const s = open()
      s.start()
      s.scheduleReconnectAt(Date.now() + 10)
      vi.advanceTimersByTime(10)
      expect(sockets).toHaveLength(1)
      sockets[0]!.open()
      expect(statuses).toEqual(['connected'])
    })

    it('stop durante una rotación cierra las dos conexiones', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.scheduleReconnectAt(Date.now() + 60_000)
      vi.advanceTimersByTime(60_000)
      s.stop()
      expect(sockets.map((sk) => sk.readyState)).toEqual([3, 3])
      vi.advanceTimersByTime(3_600_000)
      expect(sockets).toHaveLength(2)
      expect(statuses).toEqual(['connected', 'closed'])
    })
  })

  describe('backoff', () => {
    it('espera 1 s, 2 s, 4 s entre intentos fallidos y vuelve a 1 s tras conectar', () => {
      open()
      stream.start()
      sockets[0]!.failHandshake()
      vi.advanceTimersByTime(999)
      expect(sockets).toHaveLength(1)
      vi.advanceTimersByTime(1)
      sockets[1]!.failHandshake()
      vi.advanceTimersByTime(1_999)
      expect(sockets).toHaveLength(2)
      vi.advanceTimersByTime(1)
      sockets[2]!.failHandshake()
      vi.advanceTimersByTime(4_000)
      expect(sockets).toHaveLength(4)
      sockets[3]!.open()
      sockets[3]!.drop()
      vi.advanceTimersByTime(1_000)
      expect(sockets).toHaveLength(5)
    })
  })

  describe('vigía de silencio', () => {
    it('corta la conexión él mismo tras staleAfterMs sin mensajes ni ping, y reconecta', () => {
      open({ staleAfterMs: 60_000 })
      stream.start()
      const socket = sockets[0]!
      socket.open()
      vi.advanceTimersByTime(59_999)
      socket.receive(mark('BTCUSDT', T0))
      vi.advanceTimersByTime(59_999)
      socket.serverPing()
      vi.advanceTimersByTime(59_999)
      expect(socket.readyState).toBe(1)
      vi.advanceTimersByTime(60_000)
      expect(socket.closedBy).toBe('client-terminate')
      expect(statuses).toEqual(['connected', 'reconnecting'])
      vi.advanceTimersByTime(1_000)
      expect(sockets).toHaveLength(2)
    })

    it('las velas también cuentan como señal de vida', () => {
      open({ staleAfterMs: 60_000 })
      stream.start()
      const socket = sockets[0]!
      socket.open()
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(50_000)
        socket.receive({ stream: 'btcusdt@kline_15m', data: klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0, closed: false }) })
      }
      expect(socket.readyState).toBe(1)
    })
  })

  it('manda un pong no solicitado cada pingIntervalMs', () => {
    open({ pingIntervalMs: 120_000, staleAfterMs: 10 * 60_000 })
    stream.start()
    sockets[0]!.open()
    vi.advanceTimersByTime(119_999)
    expect(sockets[0]!.pongs).toBe(0)
    vi.advanceTimersByTime(1)
    expect(sockets[0]!.pongs).toBe(1)
    vi.advanceTimersByTime(240_000)
    expect(sockets[0]!.pongs).toBe(3)
  })
})
