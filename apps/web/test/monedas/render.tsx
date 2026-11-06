import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import type { UniverseExcluded } from '@sereno/db'
import { MonedasScreen } from '@/components/monedas/screen'
import { ToastProvider } from '@/components/ui/toast'
import { LiveProvider } from '@/lib/live/provider'
import type { LivePayload } from '@/lib/live/types'
import { liveQueryKey } from '@/lib/live/use-live'
import type { CoinDetail, CoinInfo } from '@/lib/queries/monedas'
import type { SessionContext } from '@/lib/queries/session'
import { contextFor, liveSession } from '../nav/fixtures'
import { boardCoins, boardLive, THETA } from './fixtures'

export interface ScreenOptions {
  context?: SessionContext
  live?: LivePayload
  coins?: Record<string, CoinInfo>
  excluded?: UniverseExcluded
  detail?: CoinDetail | null
}

/**
 * La pantalla como la arma la página, dentro de lo que pone el shell: la consulta en
 * vivo (quieta: los refrescos se simulan escribiendo en la caché) y los toasts.
 */
export function renderScreen({
  context = contextFor(liveSession()),
  live = boardLive(),
  coins = boardCoins(),
  excluded = {},
  detail = null,
}: ScreenOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const base = context.isActive ? '' : `/s/${live.sessionId}`
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <LiveProvider sessionId={live.sessionId} initial={live} enabled={false}>
          <MonedasScreen context={context} base={base} coins={coins} excluded={excluded} detail={detail} theta={THETA} />
        </LiveProvider>
      </ToastProvider>
    </QueryClientProvider>,
  )
  /** Un refresco en vivo: llega otro payload a la consulta del shell (TanStack avisa en la tarea siguiente). */
  const pushLive = (next: LivePayload) =>
    act(async () => {
      client.setQueryData(liveQueryKey(live.sessionId), next)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  return { ...result, client, pushLive }
}
