'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { springDefault } from '@/lib/motion'
import type { SessionView } from '@/lib/queries/session'
import { SessionChip } from './session-chip'
import { SessionSwitch } from './session-switch'
import { showsSwitch, type SessionSwitcher } from './session-switcher'
import { TABS, tabHref } from './tabs'
import { useActiveTab } from './use-active-tab'

export interface TopBarProps {
  base: string
  /** null en el primer uso: todavía no hay simulación que nombrar. */
  session: SessionView | null
  /** El estado del bot junto al chip; sólo en la simulación activa. */
  status?: ReactNode
  /** Con la banda de contexto arriba, el área segura ya la cubre ella. */
  belowBand?: boolean
  switcher?: SessionSwitcher
}

/** Barra superior de desktop (≥ 900px): el nombre con su chip (o el selector de sesión) a la izquierda, los cinco destinos a la derecha. */
export function TopBar({ base, session, status, belowBand = false, switcher }: TopBarProps) {
  const { active, select } = useActiveTab(base)
  const home = base === '' ? '/' : base

  return (
    // Va dentro de la cabecera pegajosa: `layoutRoot` hace que el indicador se mida contra
    // la barra y no contra la página, así el scroll al cambiar de pestaña no lo desplaza.
    <motion.div layoutRoot className={clsx('material-top hidden desktop:block', !belowBand && 'pt-[env(safe-area-inset-top)]')}>
      <div className="column-wide flex h-14 items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link href={home} className="pressable flex shrink-0 items-center gap-2 rounded-control" aria-label="Sereno, ir al resumen">
            <BrandMark className="size-7 rounded-[6px]!" />
            <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">Sereno</span>
          </Link>
          {/* Con selector no va el chip: el selector ya dice qué sesión se mira, y en 1024 px
              el estado del bot necesita ese lugar para no cortarse. */}
          {showsSwitch(switcher) ? <SessionSwitch switcher={switcher} base={base} className="shrink-0" /> : session && <SessionChip session={session} />}
          {status}
        </div>
        <nav aria-label="Secciones">
          <ul className="flex items-center gap-0.5">
            {TABS.map((tab) => {
              const isActive = tab.key === active
              return (
                <li key={tab.key}>
                  <Link
                    href={tabHref(base, tab)}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={(event) => select(tab.key, event)}
                    className={clsx(
                      // El peso no cambia con la pestaña activa: así ninguna etiqueta corre a las vecinas.
                      'pressable relative inline-flex h-9 items-center rounded-chip px-3.5 text-[0.9375rem] font-medium transition-colors duration-150',
                      isActive ? 'text-ink' : 'text-muted hover:text-ink',
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="top-bar-indicator"
                        transition={springDefault}
                        aria-hidden
                        className="absolute inset-0 rounded-chip bg-ink/[0.07]"
                      />
                    )}
                    <span className="relative">{tab.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </div>
    </motion.div>
  )
}
