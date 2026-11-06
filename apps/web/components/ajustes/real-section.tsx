'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Chip } from '@/components/ui/chip'
import { sessionBase } from '@/components/nav/tabs'
import type { RealPanel } from '@/lib/queries/real'
import { ENV_LABEL, UNGUARDED_TEXT } from '@/lib/real-copy'
import { RealChecks } from './real-checks'
import { RealControls } from './real-controls'
import { RealCreate } from './real-create'
import { realStateText } from './real-phrases'
import type { SectionProps } from './section-props'
import { Panel, RowFrame, SettingRow, SettingsSection } from './setting-row'

export interface RealSectionProps extends SectionProps {
  panel: RealPanel
  /** Se mira desde la sesión real (estado, tope, prender y apagar) o desde la de papel (estado y crear). */
  inRealSession: boolean
}

/**
 * Ajustes › Plata real (spec real §Dashboard): los chequeos de la cuenta, y crear,
 * prender o apagar la sesión real. Desde la simulación en papel se ve cómo está y se
 * crea; desde la sesión real, se maneja.
 */
export function RealSection({ panel, inRealSession, ...section }: RealSectionProps) {
  const { session, readiness } = panel
  const env = session?.env ?? readiness?.env ?? null
  // Sin claves el bot no puede ni cuidar las abiertas: es lo primero que se lee.
  const unguarded = session?.gate?.mode === 'unguarded' && readiness?.keysPresent !== true
  const envChip = env === null ? null : <Chip tone="muted">{ENV_LABEL[env]}</Chip>

  return (
    <SettingsSection title="Plata real">
      <Panel>
        {unguarded && (
          <RowFrame>
            <p className="text-sm font-medium text-loss text-pretty">{UNGUARDED_TEXT}</p>
          </RowFrame>
        )}
        {inRealSession && session ? <RealControls {...section} session={session} envChip={envChip} /> : <PaperSummary panel={panel} envChip={envChip} />}
        <RealChecks readiness={readiness} />
        {/* Desde adentro sólo después del tope, que no tiene vuelta: así "Empezar otra" no
            depende de que haya una simulación activa. Apagada a mano, se prende. */}
        {(inRealSession ? session?.status === 'loss_floor' : session?.status !== 'on') && <RealCreate panel={panel} replaces={session !== null} />}
      </Panel>
    </SettingsSection>
  )
}

function PaperSummary({ panel, envChip }: { panel: RealPanel; envChip: ReactNode }) {
  const { session } = panel
  if (session === null) {
    return (
      <SettingRow
        label="Operar con plata real"
        description={panel.canCreate.ok ? 'Todo listo. La simulación sigue aparte, con su plata ficticia.' : 'Está apagado: todo lo de esta simulación es ficticio.'}
        control={envChip ?? <Chip tone="muted">Apagado</Chip>}
      />
    )
  }
  return (
    <SettingRow label="Sesión con plata real" description={realStateText(session)} control={envChip}>
      <Link href={`${sessionBase(session.id)}/ajustes`} className="pressable -my-2 inline-flex min-h-11 items-center rounded-control text-sm font-medium underline underline-offset-4">
        Ver la sesión con plata real
      </Link>
    </SettingRow>
  )
}
