// Socket falso para probar `MarketStream` sin red ni tiempos reales: el test decide
// cuándo termina el handshake (`open`), qué manda el servidor (`receive`, `serverPing`)
// y cuándo se corta (`drop`, `failHandshake`). Registra lo que manda el cliente y quién
// cerró. Como `ws`, `send` lanza fuera de OPEN; a diferencia de `ws`, el evento `close`
// se emite en el acto (el stream no puede depender de que llegue tarde).

import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import type { StreamSocket, StreamSocketFactory, StreamSocketOptions } from '../ws'

export type ClosedBy = 'client-close' | 'client-terminate' | 'server'

export class FakeSocket extends EventEmitter implements StreamSocket {
  readyState: number = WebSocket.CONNECTING
  readonly sent: unknown[] = []
  pongs = 0
  closedBy: ClosedBy | null = null

  constructor(
    readonly url: string,
    readonly options: StreamSocketOptions,
  ) {
    super()
  }

  // Streams pedidos en la URL (`?streams=a/b/c`).
  get streams(): string[] {
    return (new URL(this.url).searchParams.get('streams') ?? '').split('/').filter(Boolean)
  }

  // ---------- lado servidor (lo maneja el test) ----------

  open(): void {
    if (this.readyState !== WebSocket.CONNECTING) throw new Error(`FakeSocket: open() con readyState ${this.readyState}`)
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  receive(message: unknown): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error(`FakeSocket: receive() con readyState ${this.readyState}`)
    this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }

  serverPing(): void {
    this.emit('ping', Buffer.alloc(0))
  }

  // Caída sin handshake de cierre (red, o Binance cortando a las 24 h).
  drop(code = 1006): void {
    this.finish('server', code)
  }

  // El handshake no llega a completarse (timeout, 404, DNS…): `ws` emite error y close.
  failHandshake(): void {
    this.emit('error', new Error('FakeSocket: falló el handshake'))
    this.finish('server', 1006)
  }

  // ---------- lado cliente (lo usa MarketStream) ----------

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error(`WebSocket is not open: readyState ${this.readyState}`)
    this.sent.push(JSON.parse(data))
  }

  pong(): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error(`WebSocket is not open: readyState ${this.readyState}`)
    this.pongs++
  }

  close(code = 1005): void {
    this.finish('client-close', code)
  }

  terminate(): void {
    this.finish('client-terminate', 1006)
  }

  private finish(by: ClosedBy, code: number): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.closedBy = by
    this.emit('close', code, Buffer.from(''))
  }
}

// Constructor para `MarketStream({ WebSocket })` que guarda cada socket creado, en orden.
export function fakeSocketFactory(): { WebSocket: StreamSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  class RecordedFakeSocket extends FakeSocket {
    constructor(url: string, options: StreamSocketOptions) {
      super(url, options)
      sockets.push(this)
    }
  }
  return { WebSocket: RecordedFakeSocket, sockets }
}
