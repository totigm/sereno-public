'use client'

import type { CommandView } from '@/lib/live/types'

// "Enviado al bot… ✓ aplicado" (spec §11.4) para un comando que se mandó desde esta
// pantalla: se sigue por su id en los comandos que trae `/api/live`.

export type CommandProgress = 'sent' | 'working' | 'done' | 'failed' | 'expired' | 'cancelled'

export function progressOf(command: CommandView | undefined): CommandProgress {
  if (!command) return 'sent'
  if (command.expired) return 'expired'
  switch (command.status) {
    case 'pending':
      return 'sent'
    case 'claimed':
      return 'working'
    case 'done':
      return command.result?.ok === false ? 'failed' : 'done'
    case 'failed':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'cancelled'
  }
}

export interface CommandLineProps {
  id: string
  commands: readonly CommandView[]
  /** Cómo se dice que terminó bien: "Listo: cerré todo.". */
  done: string
  /** Cómo se dice que venció sin que el bot lo tome: "El bot no respondió. No cerré nada.". */
  expired: string
  onCancel?: () => void
  onRetry?: () => void
}

const linkButton = 'pressable -my-2 inline-flex min-h-11 items-center rounded-control px-2 font-medium text-ink underline underline-offset-4'

export function CommandLine({ id, commands, done, expired, onCancel, onRetry }: CommandLineProps) {
  const command = commands.find((c) => c.id === id)
  const progress = progressOf(command)
  const text: Record<CommandProgress, string> = {
    sent: 'Enviado al bot…',
    working: 'El bot lo está haciendo…',
    done,
    failed: `El bot no pudo hacerlo${command?.result?.message ? `: ${command.result.message}` : '.'}`,
    expired,
    cancelled: 'Cancelado: no se hizo nada.',
  }
  const tone = progress === 'done' ? 'text-gain' : progress === 'failed' || progress === 'expired' ? 'text-loss' : 'text-muted'

  return (
    <p role="status" className="flex flex-wrap items-center gap-x-1 text-sm">
      <span className={tone}>{text[progress]}</span>
      {progress === 'sent' && onCancel && (
        <button type="button" onClick={onCancel} className={linkButton}>
          Cancelar
        </button>
      )}
      {progress === 'expired' && onRetry && (
        <button type="button" onClick={onRetry} className={linkButton}>
          Reintentar
        </button>
      )}
    </p>
  )
}
