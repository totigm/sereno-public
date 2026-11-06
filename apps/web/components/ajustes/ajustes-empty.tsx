import Link from 'next/link'
import { AccountSection } from './account-section'
import { ScreenHeader } from './screen-header'

/** Primer uso: todavía no hay simulación; lo único que se puede tocar es la cuenta. */
export function AjustesEmpty({ email }: { email: string }) {
  return (
    <div className="column flex flex-col pt-6">
      <ScreenHeader>
        <p className="text-muted">Todavía no hay una simulación: los ajustes aparecen cuando la crees.</p>
        <Link
          href="/"
          className="pressable mt-2.5 inline-flex h-11 w-fit items-center rounded-control bg-ink px-4 text-[0.9375rem] font-medium text-bg"
        >
          Empezar a simular
        </Link>
      </ScreenHeader>
      <AccountSection email={email} />
    </div>
  )
}
