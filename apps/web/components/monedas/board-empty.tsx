import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { LivePayload } from '@/lib/live/types'
import type { SessionContext } from '@/lib/queries/session'
import { BotCommand, MonedasEmpty } from './empty'

const FINISHED_REPLAY = new Set(['listo', 'fallido', 'cancelado'])

/** El primer uso, sin simulación: primero se crea en Resumen y después se arranca el bot. */
export function FirstRunEmpty() {
  return (
    <MonedasEmpty title="El tablero se llena cuando el bot conecte." action={{ href: '/', label: 'Ir al resumen' }}>
      Primero creá la simulación en el resumen; después arrancá el bot en la Mac con <BotCommand />.
    </MonedasEmpty>
  )
}

/** Una sesión sin snapshot de mercado: el bot todavía no conectó, calienta, o el replay no terminó. */
export function BoardEmpty({ context, live }: { context: SessionContext; live: LivePayload }) {
  const { session } = context
  if (context.isReplay) {
    const finished = session !== null && FINISHED_REPLAY.has(session.status)
    return <MonedasEmpty title={finished ? 'Este replay no dejó tablero.' : 'El tablero aparece cuando termine el replay.'} />
  }
  if (!context.isActive) return <MonedasEmpty title="Esta simulación no dejó tablero." />
  const topN = live.settings?.universe.topN ?? DEFAULT_SETTINGS.universe.topN
  const connected = live.botStatus !== null && !live.offline
  return (
    <MonedasEmpty title={connected ? 'El tablero se llena cuando el bot termine de calentar.' : 'El tablero se llena cuando el bot conecte.'}>
      Cuando arranque, acá vas a ver las {topN} monedas que mira y hacia dónde se inclina en cada una.
    </MonedasEmpty>
  )
}
