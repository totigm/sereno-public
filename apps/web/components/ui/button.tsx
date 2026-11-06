import clsx from 'clsx'
import type { ButtonHTMLAttributes } from 'react'
import { LOSS_FILL } from './loss-fill'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Acción en curso: muestra el spinner y bloquea el botón sin cambiar su ancho. */
  pending?: boolean
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-bg',
  secondary: 'bg-surface text-ink border border-line',
  ghost: 'bg-transparent text-ink hover:bg-ink/6',
  danger: LOSS_FILL,
}

const sizes: Record<ButtonSize, string> = {
  md: 'h-11 px-4 text-[0.9375rem]',
  sm: 'h-9 px-3 text-sm',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={clsx(
        'pressable relative inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap select-none',
        'disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      <span className={clsx('inline-flex items-center gap-2', pending && 'invisible')}>{children}</span>
      {pending && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center"
        >
          <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </span>
      )}
    </button>
  )
}
