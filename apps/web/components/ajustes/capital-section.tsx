'use client'

import { useId, useState } from 'react'
import type { AccountSnapshot } from '@sereno/core'
import { capitalize, formatUsdRound } from '@sereno/core/src/journal/format'
import type { Settings } from '@sereno/shared'
import { Button } from '@/components/ui/button'
import { Confirm } from '@/components/ui/confirm'
import { Segment } from '@/components/ui/segment'
import { useToast } from '@/components/ui/toast'
import { Toggle } from '@/components/ui/toggle'
import { releaseProtected } from '@/lib/actions/commands'
import { deriveAccount, deriveCapitalCard, marksOf } from '@/lib/derive'
import { releaseText } from '@/lib/release-text'
import { CommandLine, progressOf } from './command-line'
import { glue } from './glue'
import { LivePreview, shieldPast, shieldPreview } from './live-preview'
import { NumberSetting } from './number-setting'
import type { SectionProps } from './section-props'
import { Panel, ReadValue, RowFrame, SettingRow, SettingsSection } from './setting-row'
import { formatPctTrim } from './units'
import { useCommand } from './use-command'

type OnShield = Settings['capital']['onShield']

const ON_SHIELD_LABEL: Record<OnShield, string> = { keep: 'Mantener', reduce: 'Reducir', closeAll: 'Cerrar todas' }
const ON_SHIELD_HINT: Record<OnShield, string> = {
  keep: 'Las abiertas siguen como están.',
  reduce: 'Si sus márgenes no entran en la ganancia, cierro las de peor resultado hasta que entren.',
  closeAll: 'Cierro todas las abiertas en el momento de blindar.',
}
const ON_SHIELD_OPTIONS = (['keep', 'reduce', 'closeAll'] as const).map((value) => ({ value, label: ON_SHIELD_LABEL[value] }))

const OFFLINE_RELEASE = 'El bot está sin conexión: vas a poder volver a usar el capital blindado cuando se conecte.'

function reinvestText(account: AccountSnapshot): string {
  if (account.protegido > 0 && !account.reinvest) return 'No aplica mientras el capital esté blindado.'
  return account.reinvest
    ? `Cada operación se calcula sobre ${formatUsdRound(account.capitalBase)}.`
    : `Siempre sobre ${formatUsdRound(account.capitalBase)}; la ganancia se acumula aparte.`
}

export interface CapitalSectionProps extends SectionProps {
  sessionId: string
  shieldedAt: number | null
  /** El capital salió de la cuenta de futuros, no de una simulación. */
  realMoney: boolean
}

/** Capital (spec §7 y §11.1 Ajustes): blindaje con su frase viva, qué hacer al blindar, reinversión. */
export function CapitalSection({ editor, readOnly, live, sessionId, shieldedAt, realMoney }: CapitalSectionProps) {
  const { capital } = editor.config
  const [draftPct, setDraftPct] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const release = useCommand((id) => releaseProtected({ id, sessionId }))
  const offlineId = useId()
  const toast = useToast()

  const { ledger } = live
  const basis = { capitalInicial: ledger.capitalInicial, baseBlindaje: ledger.baseBlindaje }
  const account = deriveAccount(ledger, capital, live.open, marksOf(live.market))
  const shielded = ledger.protegido > 0
  const card = shielded ? deriveCapitalCard({ settings: editor.config, botStatus: live.botStatus, market: live.market, ledger, open: live.open }, shieldedAt) : null
  const releasing = release.sentId !== null && ['sent', 'working'].includes(progressOf(live.commands.find((c) => c.id === release.sentId)))

  const save = (patch: Partial<Settings['capital']>, describe: string) =>
    editor.commit({ capital: { ...capital, ...patch } }, { describe, unit: 'pct' })

  const confirmRelease = async () => {
    // El bot puede quedarse sin conexión con la confirmación abierta.
    if (live.offline) {
      setConfirming(false)
      toast({ message: OFFLINE_RELEASE })
      return
    }
    if (await release.send('Enviado al bot: vuelve a usar el capital blindado.')) setConfirming(false)
  }

  return (
    <SettingsSection title="Capital">
      <Panel>
        <SettingRow
          label="Capital inicial"
          description={readOnly ? undefined : realMoney ? 'Lo asignaste de tu cuenta de futuros al crear la sesión.' : 'Se fija al crear la simulación.'}
          control={<ReadValue>{formatUsdRound(ledger.capitalInicial)}</ReadValue>}
        />

        {readOnly ? (
          <SettingRow
            label="Blindaje"
            description={shieldPast(capital.protectPct, basis)}
            control={<ReadValue>{capital.protectPct > 0 ? formatPctTrim(capital.protectPct) : 'Apagado'}</ReadValue>}
          />
        ) : (
          <NumberSetting
            label="Blindaje"
            value={capital.protectPct}
            unit="pct"
            onDraft={setDraftPct}
            onCommit={(n) => save({ protectPct: n }, n > 0 ? `blindaje al ${formatPctTrim(n)}` : 'blindaje apagado')}
            {...(shielded ? { description: 'Vuelve a contar cuando uses otra vez el capital blindado.' } : {})}
          >
            {card ? (
              <div className="flex flex-col gap-3 rounded-control bg-bg px-3.5 py-3">
                <p className="text-[0.9375rem] text-pretty">
                  {glue(`${card.title} ${card.detail}`)}
                </p>
                {card.atRisk && <p className="text-sm font-medium text-loss">{glue(`${capitalize(card.atRisk)}.`)}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button onClick={() => setConfirming(true)} disabled={releasing || live.offline} aria-describedby={live.offline ? offlineId : undefined}>
                    Volver a usar el capital blindado
                  </Button>
                  {release.sentId && (
                    <CommandLine
                      id={release.sentId}
                      commands={live.commands}
                      done="Listo: el capital blindado vuelve a operar."
                      expired="El bot no lo tomó a tiempo: el capital sigue blindado."
                      onCancel={release.cancel}
                    />
                  )}
                </div>
                {live.offline && (
                  <p id={offlineId} className="text-sm text-pretty text-muted">
                    {OFFLINE_RELEASE}
                  </p>
                )}
              </div>
            ) : (
              <LivePreview text={shieldPreview(draftPct ?? capital.protectPct, basis)} />
            )}
          </NumberSetting>
        )}

        {readOnly ? (
          <SettingRow label="Al blindar, con las abiertas" control={<ReadValue>{ON_SHIELD_LABEL[capital.onShield]}</ReadValue>} />
        ) : (
          <SettingRow
            label="Al blindar, con las abiertas"
            description={ON_SHIELD_HINT[capital.onShield]}
            wrap
            control={
              <Segment
                label="Al blindar, con las abiertas"
                options={ON_SHIELD_OPTIONS}
                value={capital.onShield}
                onChange={(value) => save({ onShield: value }, `al blindar, ${ON_SHIELD_LABEL[value].toLowerCase()}`)}
              />
            }
          />
        )}

        {readOnly ? (
          <SettingRow label="Reinvertir ganancias" control={<ReadValue>{capital.reinvest ? 'Sí' : 'No'}</ReadValue>} />
        ) : (
          <RowFrame>
            <Toggle
              label="Reinvertir ganancias"
              description={glue(reinvestText(account))}
              checked={capital.reinvest}
              onChange={(reinvest) => save({ reinvest }, reinvest ? 'reinversión prendida' : 'reinversión apagada')}
              className="min-h-11"
            />
          </RowFrame>
        )}
      </Panel>

      <Confirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirmRelease}
        title="Volver a usar el capital blindado"
        description={glue(releaseText(ledger.protegido, ledger.saldo, capital.protectPct))}
        confirmLabel="Volver a usar"
        pending={release.pending}
      />
    </SettingsSection>
  )
}
