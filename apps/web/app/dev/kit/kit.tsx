'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Confirm } from '@/components/ui/confirm'
import { Field } from '@/components/ui/field'
import { AnimatedNumber } from '@/components/ui/number'
import { Segment } from '@/components/ui/segment'
import { Sheet } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { Toggle } from '@/components/ui/toggle'
import { formatUsd } from '@/lib/format'

const ranges = [
  { value: 'hoy', label: 'Hoy' },
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
  { value: 'todo', label: 'Todo' },
] as const

type Range = (typeof ranges)[number]['value']

const openPositions = [
  { symbol: 'SOL', side: 'Long 5x', tone: 'gain', pnl: '+12,40', since: 'hace 3 h · US$ 50' },
  { symbol: 'ETH', side: 'Short 3x', tone: 'loss', pnl: '−3,10', since: 'hace 1 h · US$ 50' },
  { symbol: 'AVAX', side: 'Long 2x', tone: 'gain', pnl: '+1,80', since: 'hace 20 min · US$ 40' },
] as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-muted">{title}</h2>
      {children}
    </section>
  )
}

export function Kit() {
  const toast = useToast()
  const [amount, setAmount] = useState(247.8)
  const [range, setRange] = useState<Range>('7d')
  const [reinvest, setReinvest] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [paused, setPaused] = useState(false)

  const pause = () => {
    setPaused(true)
    toast({
      message: 'Bot pausado. Sigo cuidando las 3 abiertas.',
      undo: () => setPaused(false),
    })
  }

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col gap-10 px-5 py-8 pb-24">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Kit de Sereno</h1>
        <p className="text-muted">Tokens, tipografía y los componentes base, con su movimiento.</p>
      </header>

      <Section title="Titular y número vivo">
        <p className="headline">
          Vas ganando{' '}
          <AnimatedNumber value={amount} format={formatUsd} className="font-bold text-gain" /> desde el 14 de
          octubre.
        </p>
        <p className="text-sm text-muted">
          Cerrado +247,80 · abierto −52,10 · hoy +38,20 · 14 de 23 ganados
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAmount((v) => v + 2.3)}>
            +US$ 2,30 (interpola)
          </Button>
          <Button size="sm" onClick={() => setAmount((v) => v - 1.15)}>
            −US$ 1,15 (interpola)
          </Button>
          <Button size="sm" onClick={() => setAmount((v) => v * 2)}>
            ×2 (fundido)
          </Button>
          <Button size="sm" onClick={() => setAmount(247.8)}>
            Volver a 247,80
          </Button>
        </div>
      </Section>

      <Section title="Chips">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="gain">Long 5x</Chip>
          <Chip tone="loss">Short 3x</Chip>
          <Chip tone="muted">Simulado</Chip>
          <Chip tone="info" dot>
            En vivo · último ciclo 14:32
          </Chip>
          <Chip tone="loss" dot>
            Sin conexión
          </Chip>
        </div>
      </Section>

      <Section title="Botones">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Empezar a simular</Button>
          <Button variant="secondary" onClick={paused ? () => setPaused(false) : pause}>
            {paused ? 'Reanudar' : 'Pausar bot'}
          </Button>
          <Button variant="ghost">Ver todo</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Cerrar ahora
          </Button>
          <Button variant="primary" pending>
            Guardando
          </Button>
          <Button variant="secondary" disabled>
            Sin conexión
          </Button>
        </div>
      </Section>

      <Section title="Campos y controles">
        <div className="panel flex flex-col gap-5 p-5">
          <Field
            label="Capital inicial"
            prefix="US$"
            inputMode="decimal"
            defaultValue="1000"
            hint="Sólo se define al crear la simulación."
          />
          <Field
            label="Blindaje"
            suffix="%"
            inputMode="numeric"
            defaultValue="150"
            error="Tiene que ser entre 10% y 100%."
          />
          <Toggle
            checked={reinvest}
            onChange={setReinvest}
            label="Reinvertir ganancias"
            description={
              reinvest ? 'Cada operación se calcula sobre US$ 1.312.' : 'Siempre sobre los US$ 1.000 iniciales.'
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-medium">Rango de la curva</span>
            <Segment options={ranges} value={range} onChange={setRange} label="Rango de la curva" />
          </div>
        </div>
      </Section>

      <Section title="Lista y hoja">
        <div className="panel overflow-hidden">
          {openPositions.map((p) => (
            <button
              key={p.symbol}
              type="button"
              onClick={() => setSheetOpen(true)}
              className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 border-t border-line px-4 py-3 text-left first:border-t-0 hover:bg-ink/4"
            >
              <span className="min-w-0 truncate">
                <span className="font-semibold">{p.symbol}</span>
                <span className="ml-2 text-sm text-muted">{p.since}</span>
              </span>
              <Chip tone={p.tone}>{p.side}</Chip>
              <span className={p.tone === 'gain' ? 'font-semibold text-gain' : 'font-semibold text-loss'}>
                {p.pnl}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Esqueleto">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-2/3" />
          </div>
          <Skeleton className="h-40 w-full rounded-panel" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </Section>

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onReopen={() => setSheetOpen(true)}
        title="SOL · Long 5x"
        footer={
          <Button variant="danger" className="w-full" onClick={() => setSheetOpen(false)}>
            Cerrar ahora
          </Button>
        }
      >
        <p className="text-muted">Entró a 142,10 · ahora 148,30 · hace 3 h</p>
        <ol className="mt-4 flex flex-col">
          {Array.from({ length: 24 }, (_, i) => (
            <li key={i} className="flex justify-between border-t border-line py-2 tabular-nums">
              <span className="text-muted">{String(14 - Math.floor(i / 4)).padStart(2, '0')}:{String((i * 15) % 60).padStart(2, '0')}</span>
              <span>{i % 3 === 0 ? 'Subí el stop a 140,90' : i % 3 === 1 ? 'Funding −0,01%' : 'Miré y esperé'}</span>
            </li>
          ))}
        </ol>
      </Sheet>

      <Confirm
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          toast({ message: 'Cerré SOL por −US$ 3,10.' })
        }}
        title="Cerrar SOL ahora"
        description="Vas a cerrar la posición por −US$ 3,10 al precio actual."
        confirmLabel="Cerrar ahora"
      />
    </main>
  )
}
