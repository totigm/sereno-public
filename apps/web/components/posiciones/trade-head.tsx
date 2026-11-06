'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { springDefault } from '@/lib/motion'
import { ResultText } from './result-text'
import { SideChip } from './side-chip'
import type { TradeSummary } from './trade-model'

/** El id de la transición compartida fila → cabecera de la hoja (spec §11.3). */
export function tradeLayoutId(id: string): string {
  return `trade-${id}`
}

export interface TradeHeadProps {
  summary: TradeSummary
  /** Sólo el bloque visible de cada trade lleva el id: dos montados con el mismo saltarían desde una caja vacía. */
  shared?: boolean
  /** Precio viejo: el resultado va apagado. */
  stale?: boolean
  /** Muestra el resultado como fracción del margen al lado. */
  withPct?: boolean
  /** En una lista densa de desktop, con la unidad en el encabezado (ver `ResultText`). */
  dense?: boolean
  /** Un dato chico junto a la moneda, apagado ("3 h" en las filas de Resumen). */
  detail?: ReactNode
  className?: string
}

/**
 * El bloque moneda + lado y apalancamiento + resultado: el mismo en la fila, la
 * tarjeta y la cabecera de la hoja, que se transforma de uno en otro al abrirla.
 * Los separadores ocultos hacen que se lea "SOL · Long 5x · +US$ 12,40 (+4,1%)".
 */
export function TradeHead({ summary, shared = false, stale = false, withPct = true, dense = false, detail, className }: TradeHeadProps) {
  return (
    <motion.span
      {...(shared ? { layoutId: tradeLayoutId(summary.id) } : {})}
      transition={springDefault}
      className={clsx('flex min-w-0 items-center justify-between gap-3', className)}
    >
      <span className="flex min-w-0 items-center gap-2">
        {/* Con el dato al lado, el que se recorta es el dato: la moneda siempre se lee entera. */}
        <span className={clsx('font-semibold', detail ? 'shrink-0' : 'truncate')}>{summary.coin}</span>
        {detail && (
          <>
            <span className="sr-only"> · </span>
            <span className="min-w-0 truncate text-muted tabular-nums">{detail}</span>
          </>
        )}
        <span className="sr-only"> · </span>
        <SideChip side={summary.side} leverage={summary.leverage} />
      </span>
      <span className="sr-only"> · </span>
      <ResultText value={summary.result} pct={withPct ? summary.pct : null} stale={stale} dense={dense} className="tabular-nums" />
    </motion.span>
  )
}
