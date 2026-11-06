// El user data stream del Binance falso, en la ruta privada `/private/ws/<listenKey>`: acepta
// sólo el listenKey vigente de la cuenta y le reenvía a cada cliente de ese listenKey los
// eventos de `FakeTrading`, como Binance (sin conexión, el evento se pierde). Los guiones
// simulan lo que Binance hace por su cuenta: vencer el listenKey (`expire`), cortar la red
// (`drop`) o atrasar el stream (`hold`: los eventos se guardan y salen al soltarlo).

import type { WebSocket } from 'ws'
import type { RawListenKeyExpired, RawUserEvent } from '../trade-types'
import type { FakeTrading } from './trading'

export const USER_STREAM_PATH = '/private/ws/'

export interface UserConnection {
  listenKey: string
  socket: WebSocket
  openedAt: number
}

export class FakeUserStream {
  connections: UserConnection[] = []
  pongs = 0
  private trading: FakeTrading | null = null
  private unsubscribe: (() => void) | null = null
  private held: RawUserEvent[] | null = null

  // Toma la cuenta nueva (el falso arma una en cada `reset`).
  attach(trading: FakeTrading): void {
    this.unsubscribe?.()
    this.trading = trading
    this.unsubscribe = trading.onEvent((event) => this.publish(event))
  }

  // El listenKey del pedido de upgrade, si es el vigente; null si hay que rechazarlo.
  acceptable(path: string): string | null {
    const listenKey = decodeURIComponent(path.slice(USER_STREAM_PATH.length))
    return listenKey !== '' && listenKey === this.trading?.listenKey ? listenKey : null
  }

  add(listenKey: string, socket: WebSocket): void {
    this.connections.push({ listenKey, socket, openedAt: Date.now() })
    socket.on('pong', () => {
      this.pongs++
    })
  }

  hold(on: boolean): void {
    if (on) {
      this.held ??= []
      return
    }
    const pending = this.held ?? []
    this.held = null
    for (const event of pending) this.send(event)
  }

  // Binance avisa por el stream y el listenKey deja de existir.
  expire(): void {
    const listenKey = this.trading?.listenKey
    if (!this.trading || !listenKey) throw new Error('FakeUserStream: no hay listenKey que vencer')
    const event: RawListenKeyExpired = { e: 'listenKeyExpired', E: String(this.trading.now()), listenKey }
    this.sendTo(listenKey, event)
    this.trading.listenKey = null
  }

  // Corta los clientes sin handshake de cierre (como una caída de red).
  drop(): void {
    for (const c of this.connections) c.socket.terminate()
  }

  ping(): void {
    for (const c of this.connections) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.ping()
    }
  }

  reset(): void {
    this.drop()
    this.connections = []
    this.held = null
    this.pongs = 0
  }

  private publish(event: RawUserEvent): void {
    if (this.held) this.held.push(event)
    else this.send(event)
  }

  private send(event: RawUserEvent): void {
    const listenKey = this.trading?.listenKey
    if (listenKey) this.sendTo(listenKey, event)
  }

  private sendTo(listenKey: string, event: unknown): void {
    const payload = JSON.stringify(event)
    for (const c of this.connections) {
      if (c.listenKey === listenKey && c.socket.readyState === c.socket.OPEN) c.socket.send(payload)
    }
  }
}
