import { useId } from 'react'

/** "Para prenderlo falta:" con lo que falta, uno por renglón (spec §6: la UI explica qué falta). */
export function MissingList({ items }: { items: readonly string[] }) {
  const id = useId()
  return (
    <div>
      <p id={id} className="text-sm font-medium">
        Para prenderlo falta:
      </p>
      <ul aria-labelledby={id} className="mt-1.5 flex flex-col gap-1 text-sm text-muted">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-pretty">
            <span aria-hidden className="mt-[0.5625rem] size-1 shrink-0 rounded-full bg-muted" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
