'use client'

import { BotStatusChips } from '@/components/status/bot-status-chips'
import { LiveErrorBand } from '@/components/status/error-band'
import { OfflineBand } from '@/components/status/offline-band'
import { OfflineTitle } from '@/components/status/offline-title'
import { useLiveContext } from '@/lib/live/provider'

/** El estado principal del bot junto al chip de la barra superior. */
export function TopBarStatus() {
  const { data } = useLiveContext()
  return <BotStatusChips live={data} limit={1} className="min-w-0" />
}

/** Las bandas globales de la simulación activa y el prefijo del título sin conexión. */
export function LiveBands() {
  return (
    <div className="column">
      <OfflineTitle />
      <OfflineBand />
      <LiveErrorBand />
    </div>
  )
}
