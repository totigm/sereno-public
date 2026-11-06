import clsx from 'clsx'
import Link from 'next/link'
import { BrandMark } from '@/components/brand-mark'
import type { SessionView } from '@/lib/queries/session'
import { SessionChip } from './session-chip'
import { SessionSwitch } from './session-switch'
import { showsSwitch, type SessionSwitcher } from './session-switcher'

/**
 * Cabecera del celu: el nombre con su chip, en el flujo de la página (se va con el
 * scroll). La navegación está abajo, al alcance del pulgar; acá arriba alcanza con
 * saber dónde se está, y el selector de sesión si hay una con plata real. Con la banda de
 * contexto arriba, el área segura ya la cubre ella.
 */
export function MobileHeader({
  base,
  session,
  belowBand,
  switcher,
}: {
  base: string
  session: SessionView | null
  belowBand: boolean
  switcher?: SessionSwitcher
}) {
  return (
    <div
      className={clsx(
        'column-wide flex items-center gap-2.5 pb-1 desktop:hidden',
        belowBand ? 'pt-4' : 'pt-[max(1rem,env(safe-area-inset-top))]',
      )}
    >
      <Link href={base === '' ? '/' : base} className="pressable flex items-center gap-2 rounded-control" aria-label="Sereno, ir al resumen">
        <BrandMark className="size-6 rounded-[5px]!" />
        <span className="font-semibold tracking-[-0.01em]">Sereno</span>
      </Link>
      {/* El chip y el selector no entran juntos en 390 px; el selector ya dice qué sesión se
          mira, y una del pasado tiene su banda de contexto. */}
      {showsSwitch(switcher) ? <SessionSwitch switcher={switcher} base={base} className="ml-auto" /> : session && <SessionChip session={session} />}
    </div>
  )
}
