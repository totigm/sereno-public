'use client'

import { useState } from 'react'
import { formatLeverage } from '@sereno/core/src/journal/format'
import type { Settings } from '@sereno/shared'
import { Segment } from '@/components/ui/segment'
import { Toggle } from '@/components/ui/toggle'
import { deriveAccount, marksOf } from '@/lib/derive'
import { customMargin, exitTranslation, liquidationDistance, liquidationWarning, tradableSymbols, worstMmr } from './custom-math'
import { glue } from './glue'
import { NumberSetting } from './number-setting'
import type { SectionProps } from './section-props'
import { Panel, ReadValue, RowFrame, SettingRow } from './setting-row'
import { formatPctTrim, formatValue, type Unit } from './units'

type Custom = Settings['custom']
type MarginKind = Custom['marginPerTrade']['kind']
type Direction = Custom['direction']

const DIRECTION_LABEL: Record<Direction, string> = { both: 'Long y short', long: 'Sólo long', short: 'Sólo short' }
const DIRECTION_OPTIONS = (['both', 'long', 'short'] as const).map((value) => ({ value, label: DIRECTION_LABEL[value] }))
const KIND_OPTIONS = [
  { value: 'usd', label: 'En dólares' },
  { value: 'pct', label: '% del capital' },
] as const satisfies ReadonlyArray<{ value: MarginKind; label: string }>

/** El trailing que se propone al prenderlo: 1% del mejor precio. */
const DEFAULT_TRAILING = 0.01

type DraftKey = 'margin' | 'leverage' | 'tp' | 'sl'

/** Las reglas del modo que el esquema no conoce: el SL antes de la liquidación y el margen en % hasta el 100%. */
const customRules =
  (symbols: readonly string[]) =>
  (next: Settings): string | null => {
    const { marginPerTrade } = next.custom
    if (marginPerTrade.kind === 'pct' && marginPerTrade.value > 1) return 'Como máximo 100% del capital.'
    return liquidationWarning(next.custom, next.risk, symbols)
  }

/** Cambiar dólares ⇄ porcentaje conserva el margen de hoy, redondeado a algo que se lea. */
function convertMargin(margin: number, to: MarginKind, capitalBase: number): Custom['marginPerTrade'] {
  if (to === 'usd') return { kind: 'usd', value: Math.max(1, Math.round(margin)) }
  const pct = capitalBase > 0 ? Math.round((margin / capitalBase) * 1000) / 1000 : 0
  return { kind: 'pct', value: Math.min(1, Math.max(0.001, pct)) }
}

function marginText(margin: Custom['marginPerTrade']): string {
  return margin.kind === 'usd' ? formatValue(margin.value, 'usd') : `${formatPctTrim(margin.value)} del capital`
}

/**
 * Los campos de "Yo fijo tamaño y salidas" (spec §5.5): margen, apalancamiento, TP y SL
 * con su traducción en vivo, trailing, posiciones máximas y dirección. La traducción y
 * el aviso de liquidación siguen a lo que se escribe, antes de guardar.
 */
export function CustomFields({ editor, readOnly, live }: SectionProps) {
  const { custom, risk } = editor.config
  const [draft, setDraft] = useState<Partial<Record<DraftKey, number>>>({})
  const track = (key: DraftKey) => (value: number | null) =>
    setDraft((current) => {
      const next = { ...current }
      if (value === null) delete next[key]
      else next[key] = value
      return next
    })

  if (readOnly) {
    return (
      <Panel>
        <SettingRow label="Margen por trade" control={<ReadValue>{marginText(custom.marginPerTrade)}</ReadValue>} />
        <SettingRow label="Apalancamiento" control={<ReadValue>{formatLeverage(custom.leverage)}</ReadValue>} />
        <SettingRow label="Take profit" control={<ReadValue>{formatPctTrim(custom.tpPct)}</ReadValue>} />
        <SettingRow label="Stop loss" control={<ReadValue>{formatPctTrim(custom.slPct)}</ReadValue>} />
        <SettingRow label="Trailing stop" control={<ReadValue>{custom.trailingPct === null ? 'No' : formatPctTrim(custom.trailingPct)}</ReadValue>} />
        <SettingRow label="Posiciones máximas" control={<ReadValue>{formatValue(custom.maxPositions, 'count')}</ReadValue>} />
        <SettingRow label="Dirección" control={<ReadValue>{DIRECTION_LABEL[custom.direction]}</ReadValue>} />
      </Panel>
    )
  }

  const { capitalBase } = deriveAccount(live.ledger, editor.config.capital, live.open, marksOf(live.market))
  const tradable = tradableSymbols(live)
  const leverage = draft.leverage ?? custom.leverage
  const slPct = draft.sl ?? custom.slPct
  const margin = customMargin({ kind: custom.marginPerTrade.kind, value: draft.margin ?? custom.marginPerTrade.value }, capitalBase)
  // El aviso va en el campo que se está editando; sin borradores, en el SL (el que se valida contra la liquidación).
  const leverageWarning = draft.leverage === undefined ? null : liquidationWarning({ ...custom, leverage: draft.leverage }, risk, tradable)
  const slWarning = draft.leverage === undefined ? liquidationWarning({ ...custom, slPct }, risk, tradable) : null

  const save = (patch: Partial<Custom>, describe: string, unit: Unit = 'count') =>
    editor.commit({ custom: { ...custom, ...patch } }, { describe, unit, check: customRules(tradable) })
  const marginUnit: Unit = custom.marginPerTrade.kind === 'usd' ? 'usd' : 'pct'

  return (
    <Panel>
      <NumberSetting
        label="Margen por trade"
        value={custom.marginPerTrade.value}
        unit={marginUnit}
        onDraft={track('margin')}
        onCommit={(value) => save({ marginPerTrade: { kind: custom.marginPerTrade.kind, value } }, `margen por trade ${formatValue(value, marginUnit)}`, marginUnit)}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Segment
            label="Margen en"
            options={KIND_OPTIONS}
            value={custom.marginPerTrade.kind}
            onChange={(kind) => {
              const next = convertMargin(margin, kind, capitalBase)
              save({ marginPerTrade: next }, `margen por trade ${marginText(next)}`, kind === 'usd' ? 'usd' : 'pct')
            }}
          />
          {custom.marginPerTrade.kind === 'pct' && (
            <span className="text-sm text-muted tabular-nums">Hoy son {formatValue(margin, 'usd')}.</span>
          )}
        </div>
      </NumberSetting>

      <NumberSetting
        label="Apalancamiento"
        value={custom.leverage}
        unit="leverage"
        onDraft={track('leverage')}
        warning={leverageWarning}
        onCommit={(value) => save({ leverage: value }, `apalancamiento ${formatLeverage(value)}`, 'leverage')}
      />

      <NumberSetting
        label="Take profit"
        value={custom.tpPct}
        unit="pct"
        onDraft={track('tp')}
        onCommit={(value) => save({ tpPct: value }, `take profit ${formatPctTrim(value)}`, 'pct')}
      >
        <p className="text-sm text-muted tabular-nums">{glue(exitTranslation('tp', draft.tp ?? custom.tpPct, margin, leverage))}</p>
      </NumberSetting>

      <NumberSetting
        label="Stop loss"
        value={custom.slPct}
        unit="pct"
        onDraft={track('sl')}
        warning={slWarning}
        onCommit={(value) => save({ slPct: value }, `stop loss ${formatPctTrim(value)}`, 'pct')}
      >
        <p className="text-sm text-muted tabular-nums">{glue(exitTranslation('sl', slPct, margin, leverage, liquidationDistance(leverage, worstMmr(risk, tradable), custom.direction)))}</p>
      </NumberSetting>

      <RowFrame>
        <Toggle
          label="Trailing stop"
          description={custom.trailingPct === null ? 'Sin trailing: cada operación sale por el TP o el SL.' : 'El stop sigue al mejor precio a la distancia de abajo.'}
          checked={custom.trailingPct !== null}
          onChange={(on) => save({ trailingPct: on ? DEFAULT_TRAILING : null }, on ? `trailing stop al ${formatPctTrim(DEFAULT_TRAILING)}` : 'sin trailing stop')}
          className="min-h-11"
        />
      </RowFrame>
      {custom.trailingPct !== null && (
        <NumberSetting
          label="Distancia del trailing"
          description="Del mejor precio que alcanzó la posición."
          value={custom.trailingPct}
          unit="pct"
          onCommit={(value) => save({ trailingPct: value }, `trailing stop al ${formatPctTrim(value)}`, 'pct')}
        />
      )}

      <NumberSetting
        label="Posiciones máximas"
        value={custom.maxPositions}
        unit="count"
        onCommit={(value) => save({ maxPositions: value }, `posiciones máximas ${formatValue(value, 'count')}`)}
      />

      <SettingRow
        label="Dirección"
        description="Hacia dónde puede abrir el bot."
        wrap
        control={
          <Segment
            label="Dirección"
            options={DIRECTION_OPTIONS}
            value={custom.direction}
            onChange={(direction) => save({ direction }, `dirección ${DIRECTION_LABEL[direction].toLowerCase()}`)}
          />
        }
      />
    </Panel>
  )
}
