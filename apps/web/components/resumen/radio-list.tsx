'use client'

import { useId } from 'react'

export interface RadioOption<T extends string> {
  value: T
  title: string
  description: string
}

export interface RadioListProps<T extends string> {
  legend: string
  name: string
  options: readonly RadioOption<T>[]
  value: T
  onChange: (value: T) => void
}

/** Opciones con una frase cada una (el modo, de dónde arranca el aprendizaje): la fila entera es el objetivo táctil. */
export function RadioList<T extends string>({ legend, name, options, value, onChange }: RadioListProps<T>) {
  const id = useId()
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-col overflow-hidden rounded-control border border-line">
        {options.map((option, i) => (
          <label key={option.value} className="flex cursor-pointer items-start gap-3 border-line px-4 py-3.5 not-first:border-t">
            <input
              type="radio"
              name={`${id}-${name}`}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              aria-labelledby={`${id}-${i}-titulo`}
              aria-describedby={`${id}-${i}-frase`}
              className="mt-[0.1875rem] size-[1.125rem] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-line bg-surface transition-[border-width,border-color] duration-150 checked:border-[5px] checked:border-ink motion-reduce:transition-none"
            />
            <span className="min-w-0">
              <span id={`${id}-${i}-titulo`} className="block font-medium">
                {option.title}
              </span>
              <span id={`${id}-${i}-frase`} className="block text-sm text-pretty text-muted">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
