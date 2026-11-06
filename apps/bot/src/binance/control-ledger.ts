// Mensajes de control de una conexión que esperan respuesta de Binance (`{ result: null, id }`
// o `{ error, id }`). Un SUBSCRIBE rechazado se reintenta hasta `maxRetries` veces con espera
// creciente; vencida la espera, el lote queda listo y el stream lo manda al ritmo de siempre.
// Un SUBSCRIBE nuevo de una moneda reemplaza a los anteriores (`supersede`): cada moneda
// tiene a lo sumo una cadena de reintentos.

import type { ControlStep } from './subscriptions'

export const SUBSCRIBE_MAX_RETRIES = 3
export const SUBSCRIBE_RETRY_BASE_MS = 1_000

export interface SentControl extends ControlStep {
  // Cuántas veces ya se reintentó este lote (0 en el primer envío).
  retries: number
}

export type ControlAnswer =
  | { kind: 'accepted' }
  // Respuesta a un id que no está esperando (ya respondido, o de antes de un reinicio).
  | { kind: 'unknown' }
  | { kind: 'unsubscribe_rejected'; control: SentControl }
  // SUBSCRIBE rechazado cuyas monedas ya salieron todas en uno más nuevo: no se reintenta.
  | { kind: 'superseded' }
  | { kind: 'retrying'; control: SentControl; delayMs: number }
  | { kind: 'failed'; control: SentControl }

export interface ControlLedgerOptions {
  retryBaseMs: number
  maxRetries: number
  // Se llama cuando vence la espera de un reintento.
  onRetryReady: () => void
}

type Timer = ReturnType<typeof setTimeout>

export class ControlLedger {
  private readonly awaiting = new Map<number, SentControl>()
  // Reintentos en espera, por el timer que los deja listos.
  private readonly waiting = new Map<Timer, SentControl>()
  private ready: SentControl[] = []

  constructor(private readonly opts: ControlLedgerOptions) {}

  sent(id: number, control: SentControl): void {
    this.awaiting.set(id, control)
  }

  answer(id: number, rejected: boolean): ControlAnswer {
    const control = this.awaiting.get(id)
    if (!control) return { kind: 'unknown' }
    this.awaiting.delete(id)
    if (!rejected) return { kind: 'accepted' }
    if (control.method === 'UNSUBSCRIBE') return { kind: 'unsubscribe_rejected', control }
    if (control.symbols.length === 0) return { kind: 'superseded' }
    if (control.retries >= this.opts.maxRetries) return { kind: 'failed', control }
    const retries = control.retries + 1
    // 1 ×, 2 ×, 4 × la base: un rechazo pasajero tiene tiempo de pasar sin insistir cada 200 ms.
    const delayMs = this.opts.retryBaseMs * 2 ** (retries - 1)
    const timer = setTimeout(() => {
      const retry = this.waiting.get(timer)
      this.waiting.delete(timer)
      if (!retry) return
      this.ready.push(retry)
      this.opts.onRetryReady()
    }, delayMs)
    timer.unref?.()
    this.waiting.set(timer, { ...control, retries })
    return { kind: 'retrying', control, delayMs }
  }

  // Salió un SUBSCRIBE nuevo con `symbols`: esas monedas dejan los lotes anteriores (los que
  // esperan respuesta, los reintentos en espera y los listos). Si no, una moneda dada de baja
  // y vuelta a pedir durante la espera recibiría un SUBSCRIBE de más y dos cadenas de reintentos.
  supersede(symbols: readonly string[]): void {
    const fresh = new Set(symbols)
    const without = (control: SentControl): SentControl => ({ ...control, symbols: control.symbols.filter((s) => !fresh.has(s)) })
    for (const [id, control] of this.awaiting) {
      if (control.method === 'SUBSCRIBE') this.awaiting.set(id, without(control))
    }
    for (const [timer, control] of this.waiting) {
      const rest = without(control)
      if (rest.symbols.length > 0) this.waiting.set(timer, rest)
      else {
        clearTimeout(timer)
        this.waiting.delete(timer)
      }
    }
    this.ready = this.ready.map(without).filter((control) => control.symbols.length > 0)
  }

  // El próximo reintento listo, reducido a los símbolos que `wanted` acepta. Los lotes que
  // se quedan sin símbolos (todos dados de baja durante la espera) se descartan.
  nextRetry(wanted: (symbol: string) => boolean): SentControl | null {
    while (this.ready.length > 0) {
      const head = this.ready[0] as SentControl
      const symbols = head.symbols.filter(wanted)
      if (symbols.length > 0) return { ...head, symbols }
      this.ready.shift()
    }
    return null
  }

  // Saca el reintento que devolvió `nextRetry`, una vez enviado.
  dropRetry(): void {
    this.ready.shift()
  }

  // La conexión se cerró: lo pendiente ya no tiene a quién llegar.
  dispose(): void {
    for (const timer of this.waiting.keys()) clearTimeout(timer)
    this.waiting.clear()
    this.awaiting.clear()
    this.ready = []
  }
}
