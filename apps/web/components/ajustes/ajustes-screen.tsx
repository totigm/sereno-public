'use client'

import { feesOrigin } from '@/lib/fees-origin'
import { useLiveContext } from '@/lib/live/provider'
import type { AjustesData } from '@/lib/queries/ajustes'
import type { RealPanel } from '@/lib/queries/real'
import type { SessionView } from '@/lib/queries/session'
import { AccountSection } from './account-section'
import { AppliedStatus } from './applied-status'
import { BotSection } from './bot-section'
import { CapitalSection } from './capital-section'
import { FeesOriginProvider } from './fees-origin'
import { ModeSection } from './mode-section'
import { RealSection } from './real-section'
import { RiskSection } from './risk-section'
import { ScreenHeader } from './screen-header'
import type { SectionProps } from './section-props'
import { UniverseSection } from './universe-section'
import { useRefreshOnRiskChange } from './use-refresh-on-risk'
import { useSettingsEditor, type Versioned } from './use-settings-editor'

/** Lo que la página le pasa a la pantalla (sin lo que ya trae el shell en vivo). */
export type AjustesScreenData = Pick<AjustesData, 'session' | 'settings' | 'defaults' | 'universe' | 'shieldedAt' | 'accountTiers'> & {
  /** Ajustes › Plata real; null en sólo lectura (replay o sesión archivada). */
  real: RealPanel | null
}

export interface AjustesScreenProps {
  data: AjustesScreenData
  /** Replay o simulación archivada: valores sin controles ni acciones sobre el bot. */
  readOnly: boolean
  email: string
}

function subtitle(session: SessionView, readOnly: boolean): string {
  if (!readOnly) return 'Cada cambio se guarda al momento y lo podés deshacer.'
  return session.kind === 'replay'
    ? 'Así estaban los ajustes de este replay. Son de sólo lectura.'
    : 'Así estaban los ajustes de esta simulación. Son de sólo lectura.'
}

/** La pantalla Ajustes (spec §11.1), igual en la simulación activa y en `/s/<id>`. */
export function AjustesScreen({ data, readOnly, email }: AjustesScreenProps) {
  const { settings } = data
  if (!settings) {
    return (
      <div className="column flex flex-col pt-6">
        <ScreenHeader>
          <p className="text-muted">Esta sesión no guardó sus ajustes: no hay nada para mostrar.</p>
        </ScreenHeader>
        <AccountSection email={email} />
      </div>
    )
  }
  return <SettingsScreen data={{ ...data, settings }} readOnly={readOnly} email={email} />
}

type SettingsScreenProps = AjustesScreenProps & {
  data: AjustesScreenData & { settings: NonNullable<AjustesScreenData['settings']> }
}

// Separada de `AjustesScreen` para que el editor arranque siempre con ajustes.
function SettingsScreen({ data, readOnly, email }: SettingsScreenProps) {
  const { session } = data
  const { data: live } = useLiveContext()
  const server: Versioned = { config: data.settings.config, version: data.settings.version }
  const liveSettings: Versioned | null = live.settings && live.settingsVersion !== null ? { config: live.settings, version: live.settingsVersion } : null
  const editor = useSettingsEditor({ sessionId: session.id, server, live: liveSettings, offline: live.offline })
  useRefreshOnRiskChange(server, liveSettings)
  const section: SectionProps = { editor, readOnly, live }
  // La sesión con plata real no se archiva ni se reemplaza desde acá: se maneja en su
  // sección, que va primero porque es lo que más importa en ella.
  const inRealSession = session.kind === 'live'
  const real = !readOnly && data.real ? <RealSection {...section} panel={data.real} inRealSession={inRealSession} /> : null

  return (
    <div className="column flex flex-col pt-6">
      <ScreenHeader>
        <p className="text-muted">{subtitle(session, readOnly)}</p>
        {!readOnly && <AppliedStatus version={editor.version} applied={live.botStatus?.settingsVersionApplied ?? null} offline={live.offline} />}
      </ScreenHeader>
      {inRealSession && real}
      <CapitalSection {...section} sessionId={session.id} shieldedAt={data.shieldedAt} realMoney={inRealSession} />
      <ModeSection {...section} />
      <FeesOriginProvider origin={feesOrigin(editor.config.risk, data.accountTiers)}>
        <RiskSection {...section} defaults={data.defaults} />
      </FeesOriginProvider>
      <UniverseSection {...section} universe={data.universe} />
      {!readOnly && !inRealSession && <BotSection {...section} sessionId={session.id} />}
      {!inRealSession && real}
      <AccountSection email={email} />
    </div>
  )
}
