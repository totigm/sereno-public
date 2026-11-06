'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { formatUsdRound } from '@sereno/core/src/journal/format'
import { Button } from '@/components/ui/button'
import { Confirm } from '@/components/ui/confirm'
import { useToast } from '@/components/ui/toast'
import { turnRealOff, turnRealOn } from '@/lib/actions/real'
import type { RealSessionView } from '@/lib/queries/real'
import { LOSS_CAP_NOTICE, TURN_OFF_TEXT } from '@/lib/real-copy'
import { CommandLine } from './command-line'
import { NumberSetting } from './number-setting'
import { REAL_CREATE_ID } from './real-create'
import { realStateText } from './real-phrases'
import type { SectionProps } from './section-props'
import { SettingRow } from './setting-row'
import { TypedConfirm } from './typed-confirm'
import { useCommand } from './use-command'

const UNSENT = 'No pude prenderla. Revisá la conexión y probá de nuevo.'

export interface RealControlsProps extends SectionProps {
  session: RealSessionView
  /** "Testnet" o "Binance real", junto al estado. */
  envChip: ReactNode
}

/**
 * La sesión con plata real, desde adentro: cómo está, prenderla si se apagó a mano, el
 * tope de pérdida y "Cerrar todo y apagar". Apagar no necesita al bot: queda apagada en
 * la base en el acto, y el bot cierra cuando toma el pedido.
 */
export function RealControls({ editor, live, session, envChip }: RealControlsProps) {
  const toast = useToast()
  const [confirming, setConfirming] = useState<'off' | 'on' | null>(null)
  const [turningOn, setTurningOn] = useState(false)
  const turnOff = useCommand((id) => turnRealOff({ id, sessionId: session.id }))
  const { risk } = editor.config

  const sendOff = async () => {
    if (await turnOff.send('Apagada. Le pedí al bot que cierre todo.')) setConfirming(null)
  }

  const sendOn = async (typed: string) => {
    setTurningOn(true)
    try {
      const result = await turnRealOn({ sessionId: session.id, confirmation: typed })
      toast({ message: result.ok ? 'Prendida: el bot vuelve a operar con plata real.' : result.message })
      if (result.ok) setConfirming(null)
    } catch {
      toast({ message: UNSENT })
    } finally {
      setTurningOn(false)
    }
  }

  const floor = session.capital * (1 - risk.lossCap)
  return (
    <>
      <SettingRow
        label={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Estado {envChip}
          </span>
        }
        description={realStateText(session)}
        control={
          session.status === 'off' ? (
            <Button onClick={() => setConfirming('on')}>Prender</Button>
          ) : session.status === 'loss_floor' ? (
            <Link href={`#${REAL_CREATE_ID}`} className="pressable inline-flex h-11 items-center rounded-control bg-ink px-4 text-[0.9375rem] font-medium text-bg">
              Empezar otra
            </Link>
          ) : undefined
        }
      />

      <NumberSetting
        label="Tope de pérdida"
        description={`Si la sesión baja a ${formatUsdRound(floor)}, cierro todo y la apago.`}
        value={risk.lossCap}
        unit="pct"
        readOnly={session.status === 'loss_floor'}
        onCommit={(lossCap) => editor.commit({ risk: { ...risk, lossCap } }, { describe: `tope de pérdida ${Math.round(lossCap * 100)}%`, unit: 'pct' })}
      >
        <p className="text-sm text-muted text-pretty">{LOSS_CAP_NOTICE}</p>
      </NumberSetting>

      <SettingRow
        wrap
        label="Cerrar todo y apagar"
        description={live.offline ? 'El bot está sin conexión: la apago ya y cierra todo cuando vuelva. Si no podés esperar, en la Mac: pnpm bot real-off.' : TURN_OFF_TEXT}
        control={
          // Después del tope ya está apagada: lo que sigue es "Empezar otra", y esto sólo cierra lo que quede.
          <Button variant={session.status === 'loss_floor' ? 'secondary' : 'danger'} onClick={() => setConfirming('off')}>
            Cerrar todo y apagar
          </Button>
        }
      >
        {turnOff.sentId && (
          <CommandLine
            id={turnOff.sentId}
            commands={live.commands}
            done="Listo: cerré todo y quedó apagada."
            expired="El bot no respondió. Quedó apagada; lo abierto se cierra cuando vuelva."
            onRetry={sendOff}
          />
        )}
      </SettingRow>

      <Confirm
        open={confirming === 'off'}
        onClose={() => setConfirming(null)}
        onConfirm={sendOff}
        title="Cerrar todo y apagar"
        description={TURN_OFF_TEXT}
        confirmLabel="Cerrar todo y apagar"
        pending={turnOff.pending}
      />
      <TypedConfirm
        open={confirming === 'on'}
        onClose={() => setConfirming(null)}
        onConfirm={sendOn}
        title="Prender la plata real"
        capital={session.capital}
        confirmLabel="Prender"
        pending={turningOn}
      />
    </>
  )
}
