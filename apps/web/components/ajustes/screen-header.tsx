import type { ReactNode } from 'react'

/** El encabezado de Ajustes: el título y, debajo, en qué contexto se está. */
export function ScreenHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1.5">
      <h1 className="headline">Ajustes</h1>
      {children}
    </header>
  )
}
