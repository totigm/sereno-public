'use client'

import clsx from 'clsx'
import { useId, useState, type ReactNode } from 'react'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { Settings } from '@sereno/shared'
import { Button } from '@/components/ui/button'
import { liquidationRule, tradableSymbols } from './custom-math'
import { FeesOrigin } from './fees-origin'
import { NumberSetting } from './number-setting'
import { Reveal } from './reveal'
import { RISK_GROUPS, sameRisk, type RiskField } from './risk-fields'
import type { SectionProps } from './section-props'
import { Panel, SettingsSection } from './setting-row'
import { formatValue } from './units'

type Risk = Settings['risk']

function withDefault(description: string | undefined, fallback: string | null): ReactNode {
  if (fallback === null) return description
  return (
    <>
      {description && `${description} `}
      <span className="whitespace-nowrap">Por defecto {fallback}</span>
    </>
  )
}

/** Un mmr fuera de (0, 1) deja la liquidación sin definir; en modo custom, además, el SL tiene que seguir antes. */
function mmrRules(next: Settings, value: number, tradable: readonly string[]): string | null {
  if (!(value > 0 && value < 1)) return 'Tiene que estar entre 0% y 100%.'
  return liquidationRule(next, tradable)
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={clsx('size-4 text-muted transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180')}
    >
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export interface RiskSectionProps extends SectionProps {
  defaults: Settings
}

/**
 * Riesgo (avanzado), plegado por defecto (spec §11.1 Ajustes): tamaño, cortes de pérdida,
 * costos y la tabla de mmr, cada uno con su valor por defecto a la vista y "Restablecer".
 */
export function RiskSection({ editor, readOnly, live, defaults }: RiskSectionProps) {
  const [open, setOpen] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const contentId = useId()
  const { risk, mode } = editor.config
  const atDefaults = sameRisk(risk, defaults.risk)

  const save = (patch: Partial<Risk>, describe: string, field: Pick<RiskField, 'unit'>, check?: (next: Settings) => string | null) =>
    editor.commit({ risk: { ...risk, ...patch } }, { describe, unit: field.unit, ...(check ? { check } : {}) })

  const summary = `Riesgo por trade ${formatValue(risk.riskPerTrade, 'pct')}, hasta ${formatValue(risk.maxLeverage, 'leverage')}, pérdida diaria ${formatValue(risk.dailyLossLimit, 'pct')} y drawdown ${formatValue(risk.maxDrawdown, 'pct')}.`
  const mmrSymbols = Object.keys(risk.mmrBySymbol).sort()
  const tradable = tradableSymbols(live)

  return (
    <SettingsSection
      title={
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((o) => !o)}
          className="pressable -mx-1 flex min-h-11 w-[calc(100%+0.5rem)] items-center justify-between gap-3 rounded-control px-1 text-left"
        >
          Riesgo (avanzado)
          <Chevron open={open} />
        </button>
      }
    >
      {!open && (
        <p className="-mt-1.5 text-sm text-muted">
          {summary} {atDefaults ? 'Son los valores por defecto.' : 'Cambiaste algunos valores.'}
        </p>
      )}
      <Reveal show={open} id={contentId}>
        <div className="flex flex-col gap-6 pt-1">
          <FeesOrigin />
          {RISK_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-muted">{group.title}</h3>
              {group.autoOnly && mode === 'custom' && (
                <p className="text-sm text-muted">En “Yo fijo tamaño y salidas” estos topes no aplican: mandan los campos del modo.</p>
              )}
              <Panel>
                {group.fields.map((field) => (
                  <NumberSetting
                    key={field.key}
                    label={field.label}
                    description={withDefault(field.description, formatValue(defaults.risk[field.key], field.unit))}
                    value={risk[field.key]}
                    unit={field.unit}
                    readOnly={readOnly}
                    onCommit={(value) => save({ [field.key]: value }, `${field.label.toLowerCase()} ${formatValue(value, field.unit)}`, field)}
                  />
                ))}
              </Panel>
            </div>
          ))}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted">Margen de mantenimiento (mmr)</h3>
            <p className="text-sm text-muted">Con él se calcula la liquidación de cada moneda.</p>
            <Panel>
              {mmrSymbols.map((symbol) => {
                const fallback = defaults.risk.mmrBySymbol[symbol]
                return (
                  <NumberSetting
                    key={symbol}
                    label={coinName(symbol)}
                    description={withDefault(undefined, fallback === undefined ? null : formatValue(fallback, 'pct'))}
                    value={risk.mmrBySymbol[symbol] ?? risk.mmrDefault}
                    unit="pct"
                    readOnly={readOnly}
                    onCommit={(value) =>
                      save({ mmrBySymbol: { ...risk.mmrBySymbol, [symbol]: value } }, `mmr de ${coinName(symbol)} ${formatValue(value, 'pct')}`, { unit: 'pct' }, (next) =>
                        mmrRules(next, value, tradable),
                      )
                    }
                  />
                )
              })}
              <NumberSetting
                label="Resto de las monedas"
                description={withDefault(undefined, formatValue(defaults.risk.mmrDefault, 'pct'))}
                value={risk.mmrDefault}
                unit="pct"
                readOnly={readOnly}
                onCommit={(value) => save({ mmrDefault: value }, `mmr del resto ${formatValue(value, 'pct')}`, { unit: 'pct' }, (next) => mmrRules(next, value, tradable))}
              />
            </Panel>
          </div>

          {!readOnly && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted">{atDefaults ? 'Son los valores por defecto.' : 'Cambiaste algunos valores.'}</p>
              <Button disabled={atDefaults} onClick={() => setResetError(save(defaults.risk, 'riesgo con los valores por defecto', { unit: 'count' }, (next) => liquidationRule(next, tradable)))}>
                Restablecer
              </Button>
            </div>
          )}
          {resetError && (
            <p role="alert" className="-mt-3 text-sm text-pretty text-loss">
              {resetError}
            </p>
          )}
        </div>
      </Reveal>
    </SettingsSection>
  )
}
