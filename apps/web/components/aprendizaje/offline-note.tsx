import clsx from 'clsx'

/** "El bot está sin conexión: lo podés reiniciar cuando vuelva.": por qué una acción sobre el bot está apagada (spec §11.1). */
export function offlineNoteText(verb: string): string {
  return `El bot está sin conexión: lo podés ${verb} cuando vuelva.`
}

export interface OfflineNoteProps {
  /** El botón apagado la referencia con `aria-describedby`. */
  id: string
  verb: string
  /** `ink` sobre fondos tenues (el aviso de los originales), donde el gris no llega al contraste. */
  tone?: 'muted' | 'ink'
}

/** La explicación junto a un botón que sin el bot queda apagado. */
export function OfflineNote({ id, verb, tone = 'muted' }: OfflineNoteProps) {
  return (
    <p id={id} className={clsx('text-sm text-pretty', tone === 'muted' && 'text-muted')}>
      {offlineNoteText(verb)}
    </p>
  )
}
