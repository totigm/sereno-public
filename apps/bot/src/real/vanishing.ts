// Posiciones del bot que Binance dejó de mostrar sin que aparezca cómo se cerraron. Una sola
// foto de `positionRisk` puede venir atrasada (un nodo lento, un fill recién hecho), así que
// hay dos pasos:
//
// - En duda: la primera vuelta de la reconciliación que no la ve. No se le mandan órdenes
//   nuevas (si de verdad se cerró, una orden ahí podría tocar lo que Toti abra), pero su stop
//   y su take profit siguen puestos: si la foto venía atrasada, la siguen cubriendo.
// - Desaparecida: otra vuelta seguida, al menos `CONFIRM_AFTER_MS` después, tampoco la ve. Ahí
//   se cancelan sus algos y se recuerda con qué estaba protegida.
//
// Si Binance la vuelve a mostrar, era una foto atrasada: la duda se olvida y una desaparecida
// vuelve a ser del bot (quien llama repone la protección guardada).

import type { Clock } from '../live/timers'

// Entre la foto que no la vio y la que lo confirma: dos fotos casi juntas pueden venir del
// mismo nodo atrasado. Las vueltas van cada 10 s (sin stream) o cada minuto.
export const CONFIRM_AFTER_MS = 5_000

// Con qué estaba protegida al desaparecer: los ids de sus algos (por ellos se sabe si el
// cierre fue un disparo) y los precios, para reponerlos si reaparece.
export interface VanishedProtection {
  algoIds: string[]
  stop: { price: number; qty: number } | null
  takeProfit: number | null
}

export class VanishedPositions {
  private readonly doubts = new Map<string, number>()
  private readonly gone = new Map<string, VanishedProtection>()

  constructor(private readonly clock: Pick<Clock, 'now'>) {}

  // La vuelta no la vio: true si con esta queda confirmada (quien llama cancela sus algos y
  // la confirma con `confirm`).
  missing(symbol: string): boolean {
    if (this.gone.has(symbol)) return false
    const since = this.doubts.get(symbol)
    if (since === undefined) {
      this.doubts.set(symbol, this.clock.now())
      return false
    }
    return this.clock.now() - since >= CONFIRM_AFTER_MS
  }

  // Sin la vuelta de la reconciliación (al arrancar): en duda desde ahora.
  doubt(symbol: string): void {
    if (!this.gone.has(symbol) && !this.doubts.has(symbol)) this.doubts.set(symbol, this.clock.now())
  }

  confirm(symbol: string, protection: VanishedProtection): void {
    this.doubts.delete(symbol)
    this.gone.set(symbol, protection)
  }

  // Binance la mostró: la duda se olvida y, si estaba desaparecida, devuelve con qué estaba
  // protegida.
  seen(symbol: string): VanishedProtection | undefined {
    this.doubts.delete(symbol)
    const protection = this.gone.get(symbol)
    this.gone.delete(symbol)
    return protection
  }

  isDoubtful(symbol: string): boolean {
    return this.doubts.has(symbol)
  }

  isGone(symbol: string): boolean {
    return this.gone.has(symbol)
  }

  protectionOf(symbol: string): VanishedProtection | undefined {
    return this.gone.get(symbol)
  }

  // Llegó su cierre: ya no hay nada que buscar.
  forget(symbol: string): void {
    this.doubts.delete(symbol)
    this.gone.delete(symbol)
  }
}
