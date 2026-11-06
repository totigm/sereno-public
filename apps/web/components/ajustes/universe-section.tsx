'use client'

import { useState } from 'react'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { Settings } from '@sereno/shared'
import { Toggle } from '@/components/ui/toggle'
import type { AjustesData, UniverseOutView } from '@/lib/queries/ajustes'
import { CoinList } from './coin-list'
import { glue } from './glue'
import { NumberSetting } from './number-setting'
import type { SectionProps } from './section-props'
import { Panel, ReadValue, RowFrame, SettingRow, SettingsSection } from './setting-row'
import { formatValue } from './units'
import { universeOutPhrase } from './universe-reasons'

type Universe = Settings['universe']

/** Las que se ven sin desplegar: el resto queda detrás de "Ver todas". */
const SHOWN_OUT = 6

// Primero lo que depende del capital (el mínimo), después las fijadas que no entraron, después el resto.
function outRank(out: UniverseOutView): number {
  if (out.reason === 'below_min_notional') return 0
  return out.pinned ? 1 : 2
}

export interface UniverseSectionProps extends SectionProps {
  universe: AjustesData['universe']
}

/** Universo (spec §5.1 y §11.1 Ajustes): top N, fijadas, excluidas, TradFi y qué queda fuera y por qué. */
export function UniverseSection({ editor, readOnly, universe }: UniverseSectionProps) {
  const settings = editor.config.universe
  const [showAllOut, setShowAllOut] = useState(false)
  const names = new Map(universe.available.map((c) => [c.symbol, c.name]))
  const nameOf = (symbol: string) => names.get(symbol) ?? coinName(symbol)
  const byName = [...universe.available].sort((a, b) => a.name.localeCompare(b.name, 'es'))

  const save = (patch: Partial<Universe>, describe: string) => editor.commit({ universe: { ...settings, ...patch } }, { describe })
  const without = (list: readonly string[], symbol: string) => list.filter((s) => s !== symbol)

  // Las excluidas a mano ya están en su lista; acá van las que deja fuera un filtro o el mínimo.
  const out = Object.entries(universe.excluded)
    .filter(([, entry]) => entry.reason !== 'excluded')
    .sort(([a, x], [b, y]) => outRank(x) - outRank(y) || nameOf(a).localeCompare(nameOf(b), 'es'))
  const shownOut = showAllOut ? out : out.slice(0, SHOWN_OUT)
  const anyBelowMinimum = out.some(([, entry]) => entry.reason === 'below_min_notional')
  // En sólo lectura (replay o archivada) el universo es el del último día, no el de hoy.
  const count = universe.current.length
  const topNText = count === 0 ? 'Las de más volumen en 24 h.' : `Las de más volumen en 24 h. ${readOnly ? `Al final eran ${count}` : `Hoy hay ${count}`}.`
  const outText = readOnly
    ? anyBelowMinimum
      ? 'Las que el bot no podía operar y por qué.'
      : 'Ninguna moneda quedaba fuera por el mínimo con ese capital.'
    : anyBelowMinimum
      ? 'Las que el bot no puede operar y por qué.'
      : 'Ninguna moneda queda fuera por el mínimo con tu capital.'

  return (
    <SettingsSection title="Universo">
      <Panel>
        <NumberSetting
          label="Monedas en el tablero"
          description={topNText}
          value={settings.topN}
          unit="count"
          readOnly={readOnly}
          onCommit={(topN) => save({ topN }, `${formatValue(topN, 'count')} monedas en el tablero`)}
        />
        <CoinList
          label="Fijadas"
          description="Entran siempre, aunque no estén entre las de más volumen."
          symbols={settings.pinned}
          options={byName.filter((c) => !settings.pinned.includes(c.symbol))}
          nameOf={nameOf}
          addLabel="Fijar una moneda"
          removeLabel={(name) => `Sacar ${name} de las fijadas`}
          emptyText="Ninguna fijada."
          readOnly={readOnly}
          onAdd={(symbol) => save({ pinned: [...settings.pinned, symbol], excluded: without(settings.excluded, symbol) }, `${nameOf(symbol)} fijada`)}
          onRemove={(symbol) => save({ pinned: without(settings.pinned, symbol) }, `${nameOf(symbol)} ya no está fijada`)}
        />
        <CoinList
          label="Excluidas"
          description="No entran nunca, aunque tengan volumen."
          symbols={settings.excluded}
          options={byName.filter((c) => !settings.excluded.includes(c.symbol))}
          nameOf={nameOf}
          addLabel="Excluir una moneda"
          removeLabel={(name) => `Sacar ${name} de las excluidas`}
          emptyText="Ninguna excluida."
          readOnly={readOnly}
          onAdd={(symbol) => save({ excluded: [...settings.excluded, symbol], pinned: without(settings.pinned, symbol) }, `${nameOf(symbol)} excluida`)}
          onRemove={(symbol) => save({ excluded: without(settings.excluded, symbol) }, `${nameOf(symbol)} ya no está excluida`)}
        />
        {readOnly ? (
          <SettingRow label="Incluir TradFi" control={<ReadValue>{settings.includeTradFi ? 'Sí' : 'No'}</ReadValue>} />
        ) : (
          <RowFrame>
            <Toggle
              label="Incluir TradFi"
              description="Oro y acciones tokenizadas que Binance lista como futuros."
              checked={settings.includeTradFi}
              onChange={(includeTradFi) => save({ includeTradFi }, includeTradFi ? 'TradFi incluido' : 'TradFi fuera')}
              className="min-h-11"
            />
          </RowFrame>
        )}
        <SettingRow
          label="Fuera del tablero"
          description={outText}
        >
          {out.length > 0 && (
            <div className="flex flex-col items-start gap-1">
              <ul className="flex flex-col gap-1 text-sm">
                {shownOut.map(([symbol, entry]) => (
                  <li key={symbol}>{glue(universeOutPhrase(symbol, entry))}</li>
                ))}
              </ul>
              {out.length > SHOWN_OUT && (
                <button
                  type="button"
                  onClick={() => setShowAllOut((v) => !v)}
                  className="pressable -mx-2 inline-flex min-h-11 items-center rounded-control px-2 text-sm font-medium underline underline-offset-4"
                >
                  {showAllOut ? 'Ver menos' : `Ver las ${out.length}`}
                </button>
              )}
            </div>
          )}
        </SettingRow>
      </Panel>
    </SettingsSection>
  )
}
