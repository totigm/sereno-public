'use client'

import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { Chip } from '@/components/ui/chip'
import { fade, springDefault } from '@/lib/motion'
import { botStatusChips, type StatusChip } from './bot-status'

export interface BotStatusChipsProps {
  live: Parameters<typeof botStatusChips>[0]
  /** Cuántos mostrar, empezando por el principal (la barra superior muestra sólo el estado). */
  limit?: number
  className?: string
}

/**
 * Los chips de estado del bot. Un chip que aparece o se va lo hace con un fundido
 * corto; los que cambian de texto (la hora del último ciclo) se reemplazan sin
 * moverse, porque la clave es el tipo de aviso y no el texto.
 */
export function BotStatusChips({ live, limit, className }: BotStatusChipsProps) {
  const chips: StatusChip[] = botStatusChips(live).slice(0, limit)
  return (
    <ul aria-label="Estado del bot" className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {chips.map((c) => (
          <motion.li
            key={c.key}
            title={c.text}
            className="min-w-0 max-w-full"
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ ...fade, layout: springDefault }}
          >
            {/* Donde no entra entero (la barra de arriba en 1024 px), se corta con puntos suspensivos y el texto entero queda en el `title`. */}
            <Chip tone={c.tone} dot={c.dot} className="max-w-full">
              <span className="min-w-0 truncate">{c.text}</span>
            </Chip>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}
