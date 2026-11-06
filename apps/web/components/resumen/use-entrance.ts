'use client'

import clsx from 'clsx'
import { useState, type CSSProperties } from 'react'
import { useHydrated } from '@/lib/use-hydrated'
import styles from './entrance.module.css'

export interface EntranceProps {
  className: string | undefined
  style: CSSProperties | undefined
}

/**
 * La secuencia de entrada corre sólo en la carga inicial (spec §11.3): cuando la página
 * llega del servidor y se hidrata. Al volver a Resumen desde otra pestaña el
 * componente se monta en el cliente y aparece quieto. Lo que se decide al montar no
 * cambia después: sacar la clase a mitad de la animación la cortaría.
 */
export function useEntrance(): (step: number, className?: string) => EntranceProps {
  const clientMount = useHydrated()
  const [animate] = useState(!clientMount)
  return (step, className) => ({
    className: clsx(className, animate && styles.item) || undefined,
    style: animate ? ({ '--step': step } as CSSProperties) : undefined,
  })
}
