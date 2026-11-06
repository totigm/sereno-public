// Limitador central del cliente REST (spec §3): tres clases de límite de Binance
// USDT-M, cada una con su ventana. Frena antes del 429 y, cuando llega el header
// `X-MBX-USED-WEIGHT-1M`, se alinea con lo que Binance contó de verdad.

export type LimitKind = 'weight' | 'data' | 'funding'

// `high`: órdenes y reconciliación de la sesión real, que no pueden esperar detrás de la
// recolección de datos de mercado.
export type Priority = 'normal' | 'high'

export interface RateLimiterOptions {
  weightPerMinute: number
  dataRequestsPer5m: number
  fundingRequestsPer5m: number
  now?: () => number
}

interface Entry {
  at: number
  weight: number
  seq: number
}

interface Window {
  limit: number
  spanMs: number
  entries: Entry[]
}

interface Waiter {
  kind: LimitKind
  weight: number
  priority: Priority
  resolve: () => void
}

const MINUTE = 60_000
const FIVE_MINUTES = 300_000

export class RateLimiter {
  private readonly windows: Record<LimitKind, Window>
  private readonly now: () => number
  private readonly waiters: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private seq = 0
  private heldUntil = 0
  // Último header observado: lo que Binance contó, y hasta qué pedido nuestro lo incluye.
  private header: { at: number; used: number; seq: number } | null = null

  constructor(opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now
    this.windows = {
      weight: { limit: opts.weightPerMinute, spanMs: MINUTE, entries: [] },
      data: { limit: opts.dataRequestsPer5m, spanMs: FIVE_MINUTES, entries: [] },
      funding: { limit: opts.fundingRequestsPer5m, spanMs: FIVE_MINUTES, entries: [] },
    }
  }

  // Reserva `weight` unidades de la clase `kind`; resuelve cuando hay lugar, en orden de llegada
  // dentro de cada prioridad: una `high` pasa delante de toda `normal` que esté esperando.
  // Para `data` y `funding` el peso es la cantidad de pedidos (1 por llamada; 0 se cuenta como 1).
  acquire(kind: LimitKind, weight: number, priority: Priority = 'normal'): Promise<void> {
    const cost = Math.max(1, weight)
    const { limit } = this.windows[kind]
    if (cost > limit) return Promise.reject(new Error(`RateLimiter: peso ${weight} supera el límite ${limit} de '${kind}'`))
    const ahead = priority === 'high' ? this.waiters.some((w) => w.priority === 'high') : this.waiters.length > 0
    if (!ahead && this.tryTake(kind, cost)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { kind, weight: cost, priority, resolve }
      const firstNormal = priority === 'high' ? this.waiters.findIndex((w) => w.priority === 'normal') : -1
      if (firstNormal < 0) this.waiters.push(waiter)
      else this.waiters.splice(firstNormal, 0, waiter)
      this.reschedule()
    })
  }

  // Valor de `X-MBX-USED-WEIGHT-1M` de la última respuesta. Binance cuenta por minuto de
  // reloj, así que el valor vale hasta el próximo cambio de minuto.
  observeHeader(usedWeight1m: number): void {
    if (!Number.isFinite(usedWeight1m) || usedWeight1m < 0) return
    this.header = { at: this.now(), used: usedWeight1m, seq: this.seq }
  }

  // Frena todas las clases hasta `t` (castigo de un 429/418 con Retry-After).
  holdUntil(t: number): void {
    this.heldUntil = Math.max(this.heldUntil, t)
  }

  // Uso actual de la clase (lo mayor entre lo contado acá y lo que dijo Binance).
  used(kind: LimitKind): number {
    const now = this.now()
    this.prune(now)
    const local = sum(this.windows[kind].entries)
    return kind === 'weight' ? Math.max(local, this.headerUsed(now)) : local
  }

  get pending(): number {
    return this.waiters.length
  }

  private tryTake(kind: LimitKind, weight: number): boolean {
    const now = this.now()
    this.prune(now)
    if (this.waitFor(kind, weight, now) > 0) return false
    this.windows[kind].entries.push({ at: now, weight, seq: ++this.seq })
    return true
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0]!
      if (!this.tryTake(head.kind, head.weight)) break
      this.waiters.shift()
      head.resolve()
    }
    this.schedule()
  }

  // La cabeza de la fila pudo cambiar (entró una `high` adelante): el temporizador se
  // vuelve a calcular para ella.
  private reschedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== null) return
    const head = this.waiters[0]
    if (!head) return
    const wait = Math.max(1, this.waitFor(head.kind, head.weight, this.now()))
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, wait)
    this.timer.unref?.()
  }

  // Milisegundos que faltan para que `weight` entre en la clase `kind` (0 si entra ya).
  private waitFor(kind: LimitKind, weight: number, now: number): number {
    const window = this.windows[kind]
    let wait = Math.max(0, this.heldUntil - now)
    const local = sum(window.entries)
    if (local + weight > window.limit) {
      // Hay que esperar a que venzan las entradas más viejas hasta liberar lo que falta.
      let needed = local + weight - window.limit
      for (const entry of window.entries) {
        needed -= entry.weight
        if (needed <= 0) {
          wait = Math.max(wait, entry.at + window.spanMs - now)
          break
        }
      }
    }
    if (kind === 'weight' && this.headerUsed(now) + weight > window.limit) {
      wait = Math.max(wait, nextMinute(now) - now)
    }
    return wait
  }

  // Lo que Binance contó en el minuto actual más lo que mandamos después de ese header.
  private headerUsed(now: number): number {
    const header = this.header
    if (!header || minuteOf(header.at) !== minuteOf(now)) return 0
    const since = this.windows.weight.entries.filter((e) => e.seq > header.seq)
    return header.used + sum(since)
  }

  private prune(now: number): void {
    for (const window of Object.values(this.windows)) {
      const cutoff = now - window.spanMs
      let drop = 0
      while (drop < window.entries.length && window.entries[drop]!.at <= cutoff) drop++
      if (drop > 0) window.entries.splice(0, drop)
    }
  }
}

function sum(entries: readonly Entry[]): number {
  let total = 0
  for (const e of entries) total += e.weight
  return total
}

function minuteOf(t: number): number {
  return Math.floor(t / MINUTE)
}

function nextMinute(t: number): number {
  return (minuteOf(t) + 1) * MINUTE
}
