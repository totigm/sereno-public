import type { ReactNode } from 'react'

const NBSP = ' '

/**
 * Pega con espacio duro lo que no se puede cortar al final de una línea: "US$" con su
 * número y "24 h". Va al mostrar, no en las frases: así los textos siguen siendo los
 * de la spec (y los lectores de pantalla leen lo mismo).
 */
export function glue(text: string): string
export function glue(text: ReactNode): ReactNode
export function glue(text: ReactNode): ReactNode {
  if (typeof text !== 'string') return text
  return text.replace(/US\$ /g, `US$${NBSP}`).replace(/(\d) h\b/g, `$1${NBSP}h`)
}
