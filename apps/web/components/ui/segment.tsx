'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'
import { useId, type KeyboardEvent } from 'react'
import { springDefault } from '@/lib/motion'

/** La geometría del segmento, compartida con los que navegan en lugar de elegir (el selector de sesión). */
export const segmentStyle = {
  track: 'inline-flex rounded-control bg-ink/6 p-0.5',
  // 32 px a la vista; el pseudo-elemento lleva el área táctil a 44 px.
  item: (selected: boolean) =>
    clsx(
      "relative inline-flex h-8 items-center px-3 text-sm font-medium whitespace-nowrap transition-colors duration-200 after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
      selected ? 'text-ink' : 'text-muted hover:text-ink',
    ),
  indicator: 'absolute inset-0 rounded-[8px] border border-line bg-surface',
} as const

export type SegmentOption<T extends string> = { value: T; label: string }

export type SegmentProps<T extends string> = {
  options: ReadonlyArray<SegmentOption<T>>
  value: T
  onChange: (value: T) => void
  /** Nombre del grupo para lectores de pantalla ("Rango de la curva"). */
  label: string
  className?: string
}

export function Segment<T extends string>({ options, value, onChange, label, className }: SegmentProps<T>) {
  const id = useId()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const index = options.findIndex((o) => o.value === value)
    const next = options[(index + step + options.length) % options.length]
    if (next) onChange(next.value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={clsx(segmentStyle.track, className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={segmentStyle.item(selected)}
          >
            {selected && (
              <motion.span
                layoutId={`${id}-indicator`}
                transition={springDefault}
                className={segmentStyle.indicator}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
