'use client'

import { useId, useState } from 'react'
import type { Settings } from '@sereno/shared'
import { CustomFields } from './custom-fields'
import { liquidationRule } from './custom-math'
import { Reveal } from './reveal'
import type { SectionProps } from './section-props'
import { Panel, ReadValue, SettingRow, SettingsSection } from './setting-row'
import { formatPctTrim } from './units'

type Mode = Settings['mode']

export const MODE_TITLE: Record<Mode, string> = { auto: 'El bot decide todo', custom: 'Yo fijo tamaño y salidas' }

function modeDescription(mode: Mode, riskPerTrade: number): string {
  return mode === 'auto'
    ? `Tamaño, apalancamiento y salidas salen del riesgo: un stop tocado pierde como máximo el ${formatPctTrim(riskPerTrade)} del capital.`
    : 'Vos elegís margen, apalancamiento, TP y SL. Los cortes de la cuenta siguen valiendo.'
}

interface ModeOptionProps {
  name: string
  mode: Mode
  checked: boolean
  description: string
  onSelect: () => void
}

/** Una opción del modo: la fila entera es el objetivo táctil; el título nombra el radio y la frase lo describe. */
function ModeOption({ name, mode, checked, description, onSelect }: ModeOptionProps) {
  const id = useId()
  return (
    <label className="flex cursor-pointer items-start gap-3 border-line px-4 py-3.5 not-first:border-t">
      <input
        type="radio"
        name={name}
        value={mode}
        checked={checked}
        onChange={onSelect}
        aria-labelledby={`${id}-titulo`}
        aria-describedby={`${id}-frase`}
        className="mt-[0.1875rem] size-[1.125rem] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-line bg-surface transition-[border-width,border-color] duration-150 checked:border-[5px] checked:border-ink motion-reduce:transition-none"
      />
      <span className="min-w-0">
        <span id={`${id}-titulo`} className="block font-medium">
          {MODE_TITLE[mode]}
        </span>
        <span id={`${id}-frase`} className="block text-sm text-muted text-pretty">
          {description}
        </span>
      </span>
    </label>
  )
}

/** Modo (spec §7 y §11.1 Ajustes): "El bot decide todo" o "Yo fijo tamaño y salidas" con sus campos. */
export function ModeSection(props: SectionProps) {
  const { editor, readOnly } = props
  const { mode, risk } = editor.config
  const name = useId()
  // Pasar al modo propio con un SL más allá de la liquidación no se guarda: el aviso
  // queda y los campos se muestran para corregirlos antes de volver a elegirlo.
  const [blocked, setBlocked] = useState<string | null>(null)

  if (readOnly) {
    return (
      <SettingsSection title="Modo">
        <Panel>
          <SettingRow label="Modo" description={modeDescription(mode, risk.riskPerTrade)} control={<ReadValue>{MODE_TITLE[mode]}</ReadValue>} />
        </Panel>
        {mode === 'custom' && <CustomFields {...props} />}
      </SettingsSection>
    )
  }

  const choose = (next: Mode) => {
    if (next === mode) {
      setBlocked(null)
      return
    }
    const error = editor.commit({ mode: next }, { describe: `modo “${MODE_TITLE[next]}”`, note: 'Vale para las posiciones nuevas, no para las abiertas.', check: liquidationRule })
    setBlocked(error && `No pasé a “${MODE_TITLE[next]}”: ${error.charAt(0).toLowerCase()}${error.slice(1)}`)
  }

  return (
    <SettingsSection title="Modo">
      <fieldset>
        <legend className="sr-only">Modo</legend>
        <Panel>
          {(['auto', 'custom'] as const).map((option) => (
            <ModeOption
              key={option}
              name={name}
              mode={option}
              checked={mode === option}
              description={modeDescription(option, risk.riskPerTrade)}
              onSelect={() => choose(option)}
            />
          ))}
        </Panel>
      </fieldset>
      {blocked && (
        <p role="alert" className="text-sm text-pretty text-loss">
          {blocked}
        </p>
      )}
      <p className="text-sm text-muted">En los dos casos el bot elige cuándo entrar y si es long o short.</p>
      <Reveal show={mode === 'custom' || blocked !== null}>
        <div className="pt-1">
          <CustomFields {...props} />
        </div>
      </Reveal>
    </SettingsSection>
  )
}
