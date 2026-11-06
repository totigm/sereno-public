// Sin nada de la base a propósito: lo importan la consulta de la curva y el componente de
// cliente que la dibuja, y desde `sql/equity` arrastraría `pg` al bundle del navegador.

import type { SessionKind } from '@sereno/shared'

/** Más que esto sin puntos de equity es un hueco: la curva lo dibuja punteado (spec §11.1). */
export const EQUITY_GAP_MS = 5 * 60_000

/**
 * Cada cuánto escribe puntos de equity una sesión: el replay uno por vela de 15 minutos,
 * el vivo uno por minuto. Con tramos, dos últimos puntos seguidos pueden quedar a
 * `tramo + resolución` sin que falte nada.
 */
export function equityNativeMs(kind: SessionKind): number {
  return kind === 'replay' ? 15 * 60_000 : 60_000
}
