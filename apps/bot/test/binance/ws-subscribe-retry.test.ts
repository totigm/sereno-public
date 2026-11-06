import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MarketStream, type MarketStreamOptions } from '../../src/binance/ws'
import { fakeSocketFactory, type FakeSocket } from '../../src/binance/fake/socket'

// Binance responde cada mensaje de control con `{ result: null, id }` o, si lo rechaza,
// con `{ error, id }`. Un SUBSCRIBE rechazado se reintenta con espera creciente y, si
// sigue fallando, el stream avisa qué símbolos quedaron sin datos.

const NOW = Date.UTC(2026, 9, 31, 12, 5, 0) // mitad de vela de 15m: lejos de la ventana tranquila
const REJECTED = { code: 2, msg: 'Invalid request' }

interface Sent {
  method: string
  params: string[]
  id: number
}

function sub(...symbols: string[]): { method: string; params: string[] } {
  return { method: 'SUBSCRIBE', params: symbols.flatMap((s) => [`${s}@kline_15m`, `${s}@markPrice@1s`]) }
}
function unsub(...symbols: string[]): { method: string; params: string[] } {
  return { method: 'UNSUBSCRIBE', params: symbols.flatMap((s) => [`${s}@kline_15m`, `${s}@markPrice@1s`]) }
}
function sent(socket: FakeSocket): Sent[] {
  return socket.sent as Sent[]
}
function controls(socket: FakeSocket): Array<{ method: string; params: string[] }> {
  return sent(socket).map(({ method, params }) => ({ method, params }))
}
function lastId(socket: FakeSocket): number {
  const last = sent(socket).at(-1)
  if (!last) throw new Error('el cliente no mandó ningún mensaje de control')
  return last.id
}

describe('MarketStream: SUBSCRIBE rechazado por Binance', () => {
  let sockets: FakeSocket[]
  let stream: MarketStream
  let failed: string[][]

  function start(overrides: Partial<MarketStreamOptions> = {}): FakeSocket {
    const factory = fakeSocketFactory()
    sockets = factory.sockets
    stream = new MarketStream({
      url: 'wss://fstream.binance.com/market/stream',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      streams: ['kline_15m', 'markPrice@1s'],
      WebSocket: factory.WebSocket,
      now: () => Date.now(),
      staleAfterMs: 10 * 60_000,
      ...overrides,
    })
    failed = []
    stream.on('subscription_failed', (symbols) => failed.push(symbols))
    stream.start()
    const socket = sockets[0]!
    socket.open()
    return socket
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    stream.stop()
    vi.useRealTimers()
  })

  it('reintenta el lote hasta 3 veces con espera creciente y después avisa subscription_failed', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    expect(controls(socket)).toEqual([sub('solusdt')])

    // Esperas de 1 s, 2 s y 4 s antes de cada reintento.
    for (const [retry, delay] of [[1, 1_000], [2, 2_000], [3, 4_000]] as const) {
      socket.receive({ error: REJECTED, id: lastId(socket) })
      vi.advanceTimersByTime(delay - 1)
      expect(socket.sent).toHaveLength(retry)
      vi.advanceTimersByTime(1)
      expect(socket.sent).toHaveLength(retry + 1)
      expect(controls(socket).at(-1)).toEqual(sub('solusdt'))
      expect(failed).toEqual([])
    }
    const ids = sent(socket).map((m) => m.id)
    expect(new Set(ids).size).toBe(4)

    socket.receive({ error: REJECTED, id: lastId(socket) })
    expect(failed).toEqual([['SOLUSDT']])
    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toHaveLength(4)
    // El símbolo sigue pedido: lo decide el runtime (marcarlo degradado o darlo de baja).
    expect(stream.symbols).toContain('SOLUSDT')
  })

  it('si el reintento sale bien no avisa nada ni vuelve a mandar', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    vi.advanceTimersByTime(1_000)
    expect(socket.sent).toHaveLength(2)
    socket.receive({ result: null, id: lastId(socket) })
    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toHaveLength(2)
    expect(failed).toEqual([])
  })

  it('un SUBSCRIBE aceptado no se reintenta', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    socket.receive({ result: null, id: lastId(socket) })
    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toHaveLength(1)
  })

  it('el reintento sólo lleva los símbolos del lote que siguen pedidos', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT', 'XRPUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    vi.advanceTimersByTime(500)
    stream.unsubscribe(['XRPUSDT'])
    expect(controls(socket).at(-1)).toEqual(unsub('xrpusdt'))
    vi.advanceTimersByTime(500)
    expect(controls(socket).at(-1)).toEqual(sub('solusdt'))
  })

  it('si dan de baja todo el lote durante la espera no se reintenta ni se avisa', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    stream.unsubscribe(['SOLUSDT'])
    vi.advanceTimersByTime(60_000)
    expect(controls(socket)).toEqual([sub('solusdt'), unsub('solusdt')])
    expect(failed).toEqual([])
  })

  it('si la dan de baja y la vuelven a pedir durante la espera, el reintento viejo se descarta', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    stream.unsubscribe(['SOLUSDT'])
    vi.advanceTimersByTime(200)
    stream.subscribe(['SOLUSDT'])
    vi.advanceTimersByTime(200)
    expect(controls(socket)).toEqual([sub('solusdt'), unsub('solusdt'), sub('solusdt')])

    // Vence la espera del primer rechazo: el SUBSCRIBE nuevo ya lo reemplazó.
    vi.advanceTimersByTime(60_000)
    expect(controls(socket)).toEqual([sub('solusdt'), unsub('solusdt'), sub('solusdt')])

    // El SUBSCRIBE nuevo lleva su propia cadena de reintentos, una sola.
    socket.receive({ error: REJECTED, id: lastId(socket) })
    vi.advanceTimersByTime(1_000)
    expect(controls(socket)).toEqual([sub('solusdt'), unsub('solusdt'), sub('solusdt'), sub('solusdt')])
    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toHaveLength(4)
  })

  it('un reintento con varias monedas sigue con las que no se volvieron a pedir', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT', 'XRPUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    stream.unsubscribe(['XRPUSDT'])
    vi.advanceTimersByTime(200)
    stream.subscribe(['XRPUSDT'])
    vi.advanceTimersByTime(200)
    expect(controls(socket).at(-1)).toEqual(sub('xrpusdt'))
    vi.advanceTimersByTime(600)
    expect(controls(socket).at(-1)).toEqual(sub('solusdt'))
    expect(socket.sent).toHaveLength(4)
  })

  it('un rechazo que llega después de que la moneda se volvió a pedir no arma otra cadena', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    const first = lastId(socket)
    stream.unsubscribe(['SOLUSDT'])
    vi.advanceTimersByTime(200)
    stream.subscribe(['SOLUSDT'])
    vi.advanceTimersByTime(200)
    expect(controls(socket)).toEqual([sub('solusdt'), unsub('solusdt'), sub('solusdt')])

    socket.receive({ error: REJECTED, id: first })
    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toHaveLength(3)
    expect(failed).toEqual([])
  })

  it('el reintento respeta el ritmo de los mensajes de control', () => {
    const socket = start()
    stream.subscribe(['SOLUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    vi.advanceTimersByTime(900)
    stream.subscribe(['XRPUSDT'])
    expect(controls(socket).at(-1)).toEqual(sub('xrpusdt'))
    // La espera de 1 s vence a los 1000 ms, pero el último mensaje salió a los 900.
    vi.advanceTimersByTime(100)
    expect(socket.sent).toHaveLength(2)
    vi.advanceTimersByTime(100)
    expect(controls(socket).at(-1)).toEqual(sub('solusdt'))
  })

  it('un UNSUBSCRIBE rechazado no se reintenta', () => {
    const socket = start()
    stream.unsubscribe(['ETHUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    vi.advanceTimersByTime(60_000)
    expect(controls(socket)).toEqual([unsub('ethusdt')])
    expect(failed).toEqual([])
  })

  it('al reconectar, la conexión nueva trae el lote en la URL y la vieja no reintenta', () => {
    const socket = start({ backoffBaseMs: 100 })
    stream.subscribe(['SOLUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    socket.drop()
    vi.advanceTimersByTime(100)
    const next = sockets[1]!
    expect(next.streams).toContain('solusdt@kline_15m')
    next.open()
    vi.advanceTimersByTime(60_000)
    expect(next.sent).toEqual([])
    expect(socket.sent).toHaveLength(1)
    expect(failed).toEqual([])
  })

  it('la espera base se puede configurar', () => {
    const socket = start({ subscribeRetryBaseMs: 300 })
    stream.subscribe(['SOLUSDT'])
    socket.receive({ error: REJECTED, id: lastId(socket) })
    vi.advanceTimersByTime(299)
    expect(socket.sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(socket.sent).toHaveLength(2)
  })
})
