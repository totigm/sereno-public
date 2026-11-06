import clsx from 'clsx'
import { tokens } from '@/lib/theme'

// El mismo trazo que `app/icon.svg`, con los colores fijos del ícono en los dos modos:
// es la marca, no un elemento de la interfaz. El anillo lo separa del fondo oscuro.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      className={clsx('rounded-[14px] ring-1 ring-line', className)}
    >
      <rect width="64" height="64" rx="14" fill={tokens.light.ink} />
      <path
        d="M12 35c6.5 0 6.5-9 13-9s6.5 9 13 9 6.5-9 14-9"
        fill="none"
        stroke={tokens.dark.gain}
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}
