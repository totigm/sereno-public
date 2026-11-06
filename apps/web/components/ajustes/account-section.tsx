'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { authClient } from '@/lib/auth-client'
import { ACCESS_PATH } from '@/lib/return-path'
import { Panel, SettingRow, SettingsSection } from './setting-row'

/** Cuenta (spec §11.1 Ajustes): con qué email se entró y "Cerrar sesión" (salir de la cuenta, no de la simulación). */
export function AccountSection({ email }: { email: string }) {
  const router = useRouter()
  const toast = useToast()
  const [leaving, setLeaving] = useState(false)

  const signOut = async () => {
    setLeaving(true)
    try {
      const { error } = await authClient.signOut()
      if (error) throw new Error(error.message)
      router.replace(ACCESS_PATH)
    } catch {
      setLeaving(false)
      toast({ message: 'No pude cerrar la sesión. Revisá la conexión y probá de nuevo.' })
    }
  }

  return (
    <SettingsSection title="Cuenta">
      <Panel>
        <SettingRow
          label="Entraste como"
          description={<span className="break-all">{email}</span>}
          control={
            <Button onClick={signOut} pending={leaving}>
              Cerrar sesión
            </Button>
          }
        />
      </Panel>
    </SettingsSection>
  )
}
