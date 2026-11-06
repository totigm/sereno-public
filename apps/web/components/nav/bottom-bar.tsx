'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { springDefault } from '@/lib/motion'
import { useHydrated } from '@/lib/use-hydrated'
import { TabIcon } from './tab-icons'
import { TABS, tabHref } from './tabs'
import { useActiveTab } from './use-active-tab'

/**
 * Barra inferior del celu (spec §11.1–11.3): ícono y etiqueta de 11px, material
 * translúcido con el contenido pasando por detrás y el área segura de abajo.
 * Desde 900px la reemplaza la barra superior.
 */
export function BottomBar({ base }: { base: string }) {
  const { active, select } = useActiveTab(base)
  const mounted = useHydrated()

  const bar = (
    // `layoutRoot`: Motion mide en coordenadas de página; sin esto, cuando Next sube el
    // scroll al cambiar de pestaña, el indicador de esta barra fija arrancaría corrido
    // por todo lo scrolleado y entraría deslizándose en vertical.
    <motion.nav
      layoutRoot
      aria-label="Secciones"
      data-bottom-bar
      className="material fixed inset-x-0 bottom-0 z-30 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] desktop:hidden"
    >
      <ul className="mx-auto grid h-14 max-w-[560px] grid-cols-5 gap-1 px-2 py-1">
        {TABS.map((tab) => {
          const isActive = tab.key === active
          return (
            <li key={tab.key} className="flex">
              <Link
                href={tabHref(base, tab)}
                aria-current={isActive ? 'page' : undefined}
                onClick={(event) => select(tab.key, event)}
                className={clsx(
                  'pressable relative flex flex-1 flex-col items-center justify-center gap-[3px] rounded-control select-none [-webkit-tap-highlight-color:transparent]',
                  'text-[11px] leading-none font-medium tracking-[0.01em] transition-colors duration-150',
                  isActive ? 'text-ink' : 'text-muted',
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="bottom-bar-indicator"
                    transition={springDefault}
                    aria-hidden
                    className="absolute inset-0 rounded-control bg-ink/[0.07]"
                  />
                )}
                <TabIcon tab={tab.key} className="relative size-6" />
                <span className="relative">{tab.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </motion.nav>
  )

  // Una hoja abierta le pone `transform` a `[data-page-root]`, y adentro de un nodo
  // transformado `position: fixed` deja de pegarse a la ventana. Por eso la barra vive
  // en `body`; en el HTML del servidor (y al hidratar) va en su lugar, que se ve igual.
  return mounted ? createPortal(bar, document.body) : bar
}
