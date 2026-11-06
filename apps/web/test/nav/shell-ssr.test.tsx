// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/shell/app-shell'
import { contextFor, liveSession, livePayload, replaySession, withQueryClient } from './fixtures'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))

// El shell envuelve todas las pantallas: si algo de adentro toca `document` o
// `window` al renderizar, el servidor responde 500 en cada página.
describe('shell en el servidor', () => {
  it('renderiza la simulación activa, con la consulta en vivo, sin tocar el DOM', () => {
    const html = renderToString(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(html).toContain('pantalla')
    expect(html).toContain('Resumen')
    expect(html).toContain('En vivo · último ciclo 14:32')
  })

  it('renderiza un replay con su banda de contexto', () => {
    const html = renderToString(
      withQueryClient(
        <AppShell context={contextFor(replaySession())} live={livePayload({ sessionId: 'ses_replay' })} base="/s/ses_replay">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(html).toContain('Replay · 90 días · 2 ago → 31 oct')
    expect(html).toContain('Volver a la simulación actual')
  })
})
