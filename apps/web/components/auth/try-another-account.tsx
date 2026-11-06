'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { ACCESS_PATH } from '@/lib/return-path'

// Cierra la sesión que haya (la de una cuenta que salió de la lista) y vuelve a la
// pantalla de entrada limpia. Google pide elegir cuenta de nuevo (`select_account`).
export function TryAnotherAccount() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function retry() {
    setPending(true)
    await authClient.signOut().catch(() => null)
    router.replace(ACCESS_PATH)
    router.refresh()
  }

  return (
    <Button variant="primary" className="w-full" pending={pending} onClick={retry}>
      Probar con otra cuenta
    </Button>
  )
}
