import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MarketStream, type Gap, type MarketStreamOptions } from '../../src/binance/ws'
import { fakeSocketFactory, type FakeSocket } from '../../src/binance/fake/socket'
import { klineEvent } from '../../src/binance/fake/fixtures'

// Altas y bajas de símbolos contra un socket falso con reloj falso: el test decide cuándo
// termina cada handshake, así se prueban los momentos en que no hay conexión abierta.

const MIN15 = 15 * 60_000
const NOW = Date.UTC(2026, 9, 31, 12, 5, 0) // mitad de vela de 15m: lejos de la ventana tranquila
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0)

function sub(...symbols: string[]): { method: string; params: string[] } {
  return { method: 'SUBSCRIBE', params: symbols.flatMap((s) => [`${s}@kline_15m`, `${s}@markPrice@1s`]) }
}
function unsub(...symbols: string[]): { method: string; params: string[] } {
  return { method: 'UNSUBSCRIBE', params: symbols.flatMap((s) => [`${s}@kline_15m`, `${s}@markPrice@1s`]) }
}
function streamsOf(...symbols: string[]): string[] {
  return symbols.flatMap((s) => [`${s}@kline_15m`, `${s}@markPrice@1s`])
}
function closedKline(symbol: string, openTime: number): { stream: string; data: unknown } {
  return { stream: `${symbol.toLowerCase()}@kline_15m`, data: klineEvent({ symbol, interval: '15m', openTime, closed: true }) }
}
// Lo que el cliente mandó, sin los `id` (se verifican aparte).
function controls(socket: FakeSocket): Array<{ method: string; params: string[] }> {
  return socket.sent.map((m) => {
    const { method, params } = m as { method: string; params: string[] }
    return { method, params }
  })
}

describe('MarketStream: altas y bajas de símbolos', () => {
  let sockets: FakeSocket[]
  let stream: MarketStream

  function open(overrides: Partial<MarketStreamOptions> = {}): MarketStream {
    const factory = fakeSocketFactory()
    sockets = factory.sockets
    stream = new MarketStream({
      url: 'wss://fstream.binance.com/market/stream',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      streams: ['kline_15m', 'markPrice@1s'],
      WebSocket: factory.WebSocket,
      now: () => Date.now(),
      // El socket falso no manda nada solo: el vigía de silencio se prueba aparte.
      staleAfterMs: 10 * 60_000,
      ...overrides,
    })
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

  describe('mientras la conexión está en CONNECTING', () => {
    it('un subscribe sale apenas abre y sus velas se emiten', () => {
      const s = open()
      const seen: string[] = []
      s.on('kline', (symbol) => seen.push(symbol))
      s.start()
      s.subscribe(['SOLUSDT'])
      const [socket] = sockets
      expect(socket!.streams).toEqual(streamsOf('btcusdt', 'ethusdt'))
      expect(socket!.sent).toEqual([])

      socket!.open()
      expect(controls(socket!)).toEqual([sub('solusdt')])
      socket!.receive(closedKline('SOLUSDT', T0))
      expect(seen).toEqual(['SOLUSDT'])
    })

    it('un unsubscribe sale apenas abre y el símbolo deja de emitirse en el acto', () => {
      const s = open()
      const seen: string[] = []
      s.on('kline', (symbol) => seen.push(symbol))
      s.start()
      s.unsubscribe(['ETHUSDT'])
      const [socket] = sockets
      socket!.open()
      expect(controls(socket!)).toEqual([unsub('ethusdt')])
      // Lo que Binance todavía manda antes de procesar el UNSUBSCRIBE no llega al runtime.
      socket!.receive(closedKline('ETHUSDT', T0))
      socket!.receive(closedKline('BTCUSDT', T0))
      expect(seen).toEqual(['BTCUSDT'])
      expect(s.symbols).toEqual(['BTCUSDT'])
    })

    it('un alta y una baja del mismo símbolo antes de abrir se anulan: no se manda nada', () => {
      const s = open()
      s.start()
      s.subscribe(['SOLUSDT'])
      s.unsubscribe(['SOLUSDT'])
      s.unsubscribe(['ETHUSDT'])
      s.subscribe(['ETHUSDT'])
      sockets[0]!.open()
      vi.advanceTimersByTime(5_000)
      expect(sockets[0]!.sent).toEqual([])
      expect(s.symbols).toEqual(['BTCUSDT', 'ETHUSDT'])
    })

    it('varias altas pendientes salen juntas en un solo SUBSCRIBE', () => {
      const s = open()
      s.start()
      s.subscribe(['SOLUSDT'])
      s.subscribe(['XRPUSDT', 'DOGEUSDT'])
      sockets[0]!.open()
      expect(controls(sockets[0]!)).toEqual([sub('solusdt', 'xrpusdt', 'dogeusdt')])
    })
  })

  describe('al reconectar', () => {
    it('lo pedido durante el backoff entra en la URL de la conexión nueva, sin mensajes', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      sockets[0]!.drop()
      s.subscribe(['SOLUSDT'])
      s.unsubscribe(['ETHUSDT'])
      expect(sockets).toHaveLength(1)

      vi.advanceTimersByTime(1_000)
      expect(sockets).toHaveLength(2)
      expect(sockets[1]!.streams).toEqual(streamsOf('btcusdt', 'solusdt'))
      sockets[1]!.open()
      vi.advanceTimersByTime(5_000)
      expect(sockets[1]!.sent).toEqual([])
    })

    it('lo pedido durante el handshake de la reconexión sale apenas abre', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      sockets[0]!.drop()
      vi.advanceTimersByTime(1_000)
      const [, reconnecting] = sockets
      expect(reconnecting!.readyState).toBe(0)
      s.subscribe(['XRPUSDT'])
      s.unsubscribe(['BTCUSDT'])
      reconnecting!.open()
      expect(controls(reconnecting!)).toEqual([unsub('btcusdt')])
      vi.advanceTimersByTime(200)
      expect(controls(reconnecting!)).toEqual([unsub('btcusdt'), sub('xrpusdt')])
    })

    it('la conexión nueva vuelve a pedir el conjunto completo vigente, incluido lo agregado en vivo', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.subscribe(['SOLUSDT'])
      vi.advanceTimersByTime(200)
      s.unsubscribe(['ETHUSDT'])
      vi.advanceTimersByTime(200)
      expect(controls(sockets[0]!)).toEqual([sub('solusdt'), unsub('ethusdt')])

      sockets[0]!.drop()
      vi.advanceTimersByTime(1_000)
      expect(sockets[1]!.streams).toEqual(streamsOf('btcusdt', 'solusdt'))
      sockets[1]!.open()
      vi.advanceTimersByTime(5_000)
      expect(sockets[1]!.sent).toEqual([])
    })

    it('un SUBSCRIBE pendiente de turno cuando se cae la conexión no se pierde', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.subscribe(['SOLUSDT'])
      s.subscribe(['XRPUSDT']) // espera su turno de 200 ms
      sockets[0]!.drop()
      vi.advanceTimersByTime(1_000)
      expect(controls(sockets[0]!)).toEqual([sub('solusdt')])
      expect(sockets[1]!.streams).toEqual(streamsOf('btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'))
    })

    it('lo pedido durante una rotación llega a la conexión vieja y a la nueva', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.scheduleReconnectAt(Date.now() + 60_000)
      vi.advanceTimersByTime(60_000)
      const [old, next] = sockets
      expect(next!.readyState).toBe(0)
      expect(next!.streams).toEqual(streamsOf('btcusdt', 'ethusdt'))

      s.subscribe(['SOLUSDT'])
      expect(controls(old!)).toEqual([sub('solusdt')])
      next!.open()
      expect(old!.closedBy).toBe('client-close')
      expect(controls(next!)).toEqual([sub('solusdt')])
    })
  })

  describe('ritmo de los mensajes de control', () => {
    it('manda a lo sumo uno cada 200 ms (≤ 5 por segundo), las bajas primero', () => {
      const s = open()
      s.start()
      sockets[0]!.open()
      s.subscribe(['SOLUSDT'])
      s.subscribe(['XRPUSDT'])
      s.unsubscribe(['ETHUSDT'])
      const socket = sockets[0]!
      expect(controls(socket)).toEqual([sub('solusdt')])
      vi.advanceTimersByTime(199)
      expect(socket.sent).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(controls(socket)).toEqual([sub('solusdt'), unsub('ethusdt')])
      vi.advanceTimersByTime(199)
      expect(socket.sent).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(controls(socket)).toEqual([sub('solusdt'), unsub('ethusdt'), sub('xrpusdt')])
      const ids = socket.sent.map((m) => (m as { id: number }).id)
      expect(new Set(ids).size).toBe(3)
    })

    it('rechaza un intervalo menor a 200 ms: Binance corta pasados los 10 mensajes por segundo', () => {
      expect(() => open({ subscribeIntervalMs: 100 })).toThrow(/200/)
      expect(() => open({ subscribeIntervalMs: 250 })).not.toThrow()
    })
  })

  describe('estado por símbolo', () => {
    it('un símbolo dado de baja y vuelto a pedir no emite un hueco viejo', () => {
      const s = open()
      const gaps: Gap[] = []
      const seen: number[] = []
      s.on('gap', (g) => gaps.push(g))
      s.on('kline', (symbol, _tf, candle) => {
        if (symbol === 'ETHUSDT') seen.push(candle.openTime)
      })
      s.start()
      const socket = sockets[0]!
      socket.open()
      socket.receive(closedKline('ETHUSDT', T0))
      s.unsubscribe(['ETHUSDT'])
      vi.advanceTimersByTime(200)
      s.subscribe(['ETHUSDT'])
      vi.advanceTimersByTime(200)
      socket.receive(closedKline('ETHUSDT', T0 + 100 * MIN15))
      expect(gaps).toEqual([])
      expect(seen).toEqual([T0, T0 + 100 * MIN15])
    })
  })
})
