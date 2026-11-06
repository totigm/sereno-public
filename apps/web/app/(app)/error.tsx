'use client'

import { ScreenError } from '@/components/status/screen-error'

// Una pantalla de la simulación activa que falla: el shell queda y se puede ir a otra pestaña.
export default function AppScreenError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ScreenError error={error} retry={retry} />
}
