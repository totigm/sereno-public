import { Chip } from '@/components/ui/chip'
import type { SessionView } from '@/lib/queries/session'
import { sessionChipLabel } from './session-labels'

/** El chip persistente junto al nombre (spec §11.1). "Plata real" va en color de alerta: ahí la plata no es ficticia. */
export function SessionChip({ session, className }: { session: SessionView; className?: string }) {
  return (
    <Chip tone={session.kind === 'live' ? 'alert' : 'muted'} {...(className === undefined ? {} : { className })}>
      {sessionChipLabel(session)}
    </Chip>
  )
}
