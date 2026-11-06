'use client'

import { ScreenError } from '@/components/status/screen-error'

// Lo que falla fuera de las pantallas con shell, incluido el layout que lo arma: no
// hay navegación alrededor, así que ocupa la pantalla entera.
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ScreenError error={error} retry={retry} standalone />
}
