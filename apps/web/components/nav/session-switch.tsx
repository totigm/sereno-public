'use client'

import clsx from 'clsx'
import Link from 'next/link'
import { ALERT_FILL } from '@/components/ui/chip'
import { segmentStyle } from '@/components/ui/segment'
import { showsSwitch, type SessionSwitcher } from './session-switcher'
import { TABS, tabHref } from './tabs'
import { useActiveTab } from './use-active-tab'

/**
 * "Simulación" / "Plata real" (spec real §Dashboard), con la forma del segmento. Son
 * enlaces, no un control de estado: cambiar de sesión es navegar, y se queda en la misma
 * pestaña. "Plata real" lleva siempre su punto de alerta; marcada, va llena en el rojo de
 * alerta, como el chip: es la marca de la sesión real en la cabecera.
 */
export function SessionSwitch({ switcher, base, className }: { switcher: SessionSwitcher; base: string; className?: string }) {
  const { active } = useActiveTab(base)
  if (!showsSwitch(switcher)) return null
  const { realHref } = switcher
  const tab = TABS.find((t) => t.key === active) ?? TABS[0]
  const options = [
    { key: 'paper', label: 'Simulación', href: tab ? tabHref(switcher.paperHref, tab) : '/' },
    { key: 'real', label: 'Plata real', href: tab ? tabHref(realHref, tab) : realHref },
  ] as const

  return (
    <nav aria-label="Sesión" className={clsx(segmentStyle.track, className)}>
      {options.map((option) => {
        const selected = option.key === switcher.current
        const alert = selected && option.key === 'real'
        return (
          <Link
            key={option.key}
            href={option.href}
            aria-current={selected ? 'page' : undefined}
            {...(alert ? { 'data-tone': 'alert' } : {})}
            className={clsx(segmentStyle.item(selected), 'gap-1.5 rounded-[8px]', alert && 'text-surface dark:text-bg')}
          >
            {selected && <span aria-hidden className={alert ? clsx('absolute inset-0 rounded-[8px]', ALERT_FILL) : segmentStyle.indicator} />}
            {option.key === 'real' && <span aria-hidden className={clsx('relative size-1.5 shrink-0 rounded-full', alert ? 'bg-current' : 'bg-loss')} />}
            <span className="relative">{option.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
