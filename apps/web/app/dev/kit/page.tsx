import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Kit } from './kit'

export const metadata: Metadata = { title: 'Kit' }

// Vitrina de los componentes base para revisar el lenguaje visual y el movimiento.
// Es una herramienta de desarrollo: en un build de producción (incluidas las
// previews) la ruta no existe, así que no hace falta pedir sesión.
export default function KitPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <Kit />
}
