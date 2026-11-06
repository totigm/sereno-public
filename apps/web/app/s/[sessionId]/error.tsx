'use client'

import { ScreenError } from '@/components/status/screen-error'

// Una pantalla de otra sesión que falla: el shell y la banda de contexto quedan.
export default function SessionScreenError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ScreenError error={error} retry={retry} />
}
