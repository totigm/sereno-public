import type { EngineEvent, Position, Side } from '../types'
import { positionLevels } from './intra-candle'

// Las abiertas de un motor (de las dos carteras) con los precios en que pueden cambiar,
// llevadas a partir de sus eventos. El reproductor de velas las necesita para saber en
// qué niveles parar dentro de cada tramo; leerlas del `snapshot()` del motor en cada
// tramo costaría un clon completo del estado por vela y por motor.

interface Tracked {
  symbol: string
  side: Side
  shadow: boolean
  stopPrice: number
  liquidationPrice: number
  takeProfitPrice: number | null
}

export class LevelBook {
  private readonly open = new Map<string, Tracked>()

  track(p: Position): void {
    this.open.set(p.id, {
      symbol: p.symbol,
      side: p.side,
      shadow: p.shadow,
      stopPrice: p.stopPrice,
      liquidationPrice: p.liquidationPrice,
      takeProfitPrice: p.takeProfitPrice,
    })
  }

  apply(event: EngineEvent): void {
    switch (event.type) {
      case 'position_opened':
        this.track(event.position)
        return
      case 'stop_moved': {
        const tracked = this.open.get(event.positionId)
        if (tracked) tracked.stopPrice = event.to
        return
      }
      case 'position_closed':
        this.open.delete(event.position.id)
        return
      default:
        return
    }
  }

  has(symbol: string): boolean {
    return this.inSymbol(symbol).length > 0
  }

  // Monedas con alguna abierta, en el orden en que se abrieron.
  symbols(): string[] {
    return [...new Set([...this.open.values()].map((t) => t.symbol))]
  }

  levels(symbol: string): number[] {
    return this.inSymbol(symbol).flatMap(positionLevels)
  }

  // El lado con que se recorre la vela de la moneda: el de la posición real, o el de la
  // sombra si sólo ella tiene. Una sombra del lado contrario a la real recorre la vela
  // en el orden de la real (el precio es uno solo); para ella no es el peor caso.
  pathSide(symbol: string): Side {
    const tracked = this.inSymbol(symbol)
    const chosen = tracked.find((t) => !t.shadow) ?? tracked[0]
    if (!chosen) throw new Error(`sin abiertas en ${symbol}`)
    return chosen.side
  }

  // ¿La sombra tiene en la moneda una abierta del lado contrario a la real?
  opposed(symbol: string): boolean {
    const tracked = this.inSymbol(symbol)
    const real = tracked.find((t) => !t.shadow)
    return real !== undefined && tracked.some((t) => t.shadow && t.side !== real.side)
  }

  private inSymbol(symbol: string): Tracked[] {
    return [...this.open.values()].filter((t) => t.symbol === symbol)
  }
}
