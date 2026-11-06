'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'
import { useId, type ReactNode } from 'react'
import { springDefault } from '@/lib/motion'

export type ToggleProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}

/**
 * Interruptor con su etiqueta. Toda la fila es una `<label>` del switch, así tocar el
 * texto también lo cambia; el switch se ve de 28 px pero un pseudo-elemento lleva su
 * área táctil a 44 px.
 */
export function Toggle({ checked, onChange, label, description, disabled = false, className }: ToggleProps) {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <label className={clsx('flex items-center justify-between gap-4', disabled ? 'cursor-default' : 'cursor-pointer', className)}>
      <span className="min-w-0">
        <span id={labelId} className="block font-medium">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="block text-sm text-muted">
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative flex h-7 w-12 shrink-0 items-center rounded-chip p-0.5 transition-colors duration-200 after:absolute after:-inset-2 after:content-['']",
          checked ? 'justify-end bg-ink' : 'justify-start bg-line',
          'disabled:opacity-50',
        )}
      >
        <motion.span layout transition={springDefault} className="size-6 rounded-full bg-surface" />
      </button>
    </label>
  )
}
