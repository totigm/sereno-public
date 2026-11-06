import Link from 'next/link'
import type { ReactNode } from 'react'

export interface MonedasEmptyProps {
  title: string
  children?: ReactNode
  /** Adónde ir para que el tablero se llene. */
  action?: { href: string; label: string }
}

/** El tablero sin monedas todavía (spec §11.1, primer uso): qué falta y qué hacer. */
export function MonedasEmpty({ title, children, action }: MonedasEmptyProps) {
  return (
    <div className="column-wide flex flex-col items-start gap-3 pt-6">
      <h1 className="headline max-w-[34rem]">{title}</h1>
      {children && <p className="max-w-[34rem] text-pretty text-muted">{children}</p>}
      {action && (
        <Link
          href={action.href}
          className="pressable mt-2 inline-flex h-11 items-center rounded-control bg-ink px-4 text-[0.9375rem] font-medium text-bg"
        >
          {action.label}
        </Link>
      )}
    </div>
  )
}

/** `pnpm bot` como lo escribe la banda sin conexión. */
export function BotCommand() {
  return <code className="rounded-[6px] bg-ink/6 px-1.5 py-0.5 font-sans text-[0.8125rem] font-semibold text-ink">pnpm bot</code>
}
