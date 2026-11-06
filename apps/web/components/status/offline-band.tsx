'use client'

import { useLiveContext } from '@/lib/live/provider'
import { Band } from './band'
import { sinceClock } from './clock-labels'

/** "Bot sin conexión desde las 14:32. Precios y resultados son de ese momento." (spec §11.1). */
function offlineBandText(lastHeartbeat: number, now: number): string {
  return `Bot sin conexión desde ${sinceClock(lastHeartbeat, now)}. Precios y resultados son de ese momento.`
}

/** Sin latido hace más de 60 s, en todas las pantallas de la simulación activa. */
export function OfflineBand() {
  const { data } = useLiveContext()
  const lastBeat = data.botStatus?.lastHeartbeat
  return (
    <Band show={data.offline} tone="quiet" role="status">
      {lastBeat === undefined ? (
        <>
          El bot todavía no se conectó. Para arrancarlo, en la Mac:{' '}
          <code className="rounded-[6px] bg-ink/6 px-1.5 py-0.5 font-sans text-[0.8125rem] font-semibold">pnpm bot</code>
        </>
      ) : (
        offlineBandText(lastBeat, data.now)
      )}
    </Band>
  )
}
