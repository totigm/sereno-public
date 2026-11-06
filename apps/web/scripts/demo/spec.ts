import type { Side } from '@sereno/core'
import type { SettingsPatch } from '@sereno/db'

// Lo que un escenario declara de cada trade. Todos los instantes son cierres de vela
// (el ciclo del motor); los resultados intermedios van en R, medidos desde la
// entrada: el generador inventa un camino de precios que los cumple y comprueba con
// las reglas de salida que el trade termina exactamente como se pidió.

// Salidas a mercado por decisión (del motor, de Toti o del blindaje).
export type MarketReason = 'signal_flip' | 'manual' | 'shield_reduce'

export type ExitSpec =
  // `at`: el cierre de la vela en la que el precio cruzó el nivel.
  | { kind: 'stop'; at: number }
  | { kind: 'take_profit'; at: number }
  | { kind: 'trailing_stop'; at: number; peakR: number; peakAt: number }
  // Cierra al cumplirse `timeExitHours` con el no realizado en `r`.
  | { kind: 'time_exit'; r: number }
  | { kind: 'market'; reason: MarketReason; at: number; r: number }
  // Sigue abierta: `r` es el no realizado de ahora.
  | { kind: 'open'; r: number }

export interface Waypoint {
  at: number
  r: number
}

export interface TradeSpec {
  id: string
  symbol: string
  side: Side
  open: number
  exit: ExitSpec
  // |S′| del compuesto al abrir (≥ θ); su |S| entra en la confianza del tamaño (0,6 + 0,4·c).
  strength: number
  // Multiplica el ATR típico de la moneda: más volátil ⇒ stop más ancho.
  atrScale?: number
  waypoints?: Waypoint[]
  // La sombra copia cada trade (mismas señales, pesos congelados); sólo los cierres
  // que no decide el motor (un "cerrar ahora" de Toti) la dejan seguir sola.
  shadowExit?: ExitSpec
  shadowWaypoints?: Waypoint[]
  // Fin de la sesión del trade cuando termina antes que el mercado (un replay): todo
  // lo que decide un ciclo tiene que haberse ejecutado para entonces, y una abierta
  // se valúa ahí. Sin él, la sesión llega hasta el final del mercado.
  until?: number
}

export interface SettingsChange {
  at: number
  // Email de quien guardó; null si lo escribió el bot.
  by: string | null
  patch: SettingsPatch
}
