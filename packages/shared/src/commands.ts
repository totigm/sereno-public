import { z } from 'zod'

// Comandos que el dashboard encola en `bot_commands` y el bot reclama con claim
// atómico (spec §10). El `id` lo genera el cliente y es la clave de idempotencia.
export const COMMAND_KINDS = [
  'close_position',
  'close_all',
  'run_replay',
  'cancel_replay',
  'release_protected',
  'reset_learning',
  'real_off',
] as const

export type CommandKind = (typeof COMMAND_KINDS)[number]

// Los sensibles al precio vencen si el bot no los toma a tiempo: nunca se ejecuta
// un cierre horas después de pedido. `real_off` no está: apagar la sesión real
// nunca vence, el bot cierra todo cuando lo toma.
export const PRICE_SENSITIVE_COMMANDS = ['close_position', 'close_all'] as const satisfies readonly CommandKind[]
export const COMMAND_TTL_MS = 60_000

const base = {
  id: z.uuid(),
  sessionId: z.string().min(1),
  requestedBy: z.email(),
}

const sinPayload = z.object({}).default({})

export const CommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('close_position'), payload: z.object({ symbol: z.string().min(1) }) }),
  z.object({ ...base, kind: z.literal('close_all'), payload: sinPayload }),
  z.object({
    ...base,
    kind: z.literal('run_replay'),
    payload: z.object({
      days: z.number().int().min(1).max(365),
      capital: z.number().positive(),
      learningOrigin: z.enum(['zero', 'current']),
      paramTuning: z.boolean(),
    }),
  }),
  z.object({ ...base, kind: z.literal('cancel_replay'), payload: z.object({ replaySessionId: z.string().min(1) }) }),
  z.object({ ...base, kind: z.literal('release_protected'), payload: sinPayload }),
  z.object({ ...base, kind: z.literal('reset_learning'), payload: sinPayload }),
  z.object({ ...base, kind: z.literal('real_off'), payload: sinPayload }),
])

export type Command = z.infer<typeof CommandSchema>
export type CommandInput = z.input<typeof CommandSchema>

export function isPriceSensitive(kind: CommandKind): boolean {
  return (PRICE_SENSITIVE_COMMANDS as readonly CommandKind[]).includes(kind)
}
