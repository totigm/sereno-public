import type { ReactNode } from 'react'
import type { TabKey } from './tabs'

// Íconos de trazo propio, en una grilla de 24 con trazo de 1,75: cada uno dibuja
// lo que hay en la pantalla (la curva del titular, filas de posiciones, el tablero,
// un brote que crece, perillas de ajuste) en vez de una metáfora genérica.

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  )
}

const paths: Record<TabKey, ReactNode> = {
  resumen: (
    <>
      <path d="M3.5 15.5c2.6 0 3.2-5 6-5s3.1 3 5.6 3 3-5.5 5.4-7" />
      <path d="M3.5 20h17" />
    </>
  ),
  posiciones: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="2" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="2" />
    </>
  ),
  monedas: (
    <>
      <rect x="3.5" y="3.5" width="5" height="5" rx="1.25" />
      <rect x="9.5" y="3.5" width="5" height="5" rx="1.25" />
      <rect x="15.5" y="3.5" width="5" height="5" rx="1.25" />
      <rect x="3.5" y="9.5" width="5" height="5" rx="1.25" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.25" />
      <rect x="15.5" y="9.5" width="5" height="5" rx="1.25" />
      <rect x="3.5" y="15.5" width="5" height="5" rx="1.25" />
      <rect x="9.5" y="15.5" width="5" height="5" rx="1.25" />
      <rect x="15.5" y="15.5" width="5" height="5" rx="1.25" />
    </>
  ),
  aprendizaje: (
    <>
      <path d="M12 20.5v-8" />
      <path d="M12 12.5c0-4.1 2.9-7 7-7 0 4.1-2.9 7-7 7Z" />
      <path d="M12 15c0-3.1-2.4-5.5-6.5-5.5 0 3.1 2.4 5.5 6.5 5.5Z" />
    </>
  ),
  ajustes: (
    <>
      <path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h2.5M11.5 16.5H20" />
      <circle cx="15" cy="7.5" r="2.5" />
      <circle cx="9" cy="16.5" r="2.5" />
    </>
  ),
}

export function TabIcon({ tab, className }: { tab: TabKey; className?: string }) {
  return <Icon {...(className === undefined ? {} : { className })}>{paths[tab]}</Icon>
}
