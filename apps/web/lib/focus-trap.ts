const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Lo que Tab puede alcanzar dentro de `container`, en orden de documento. */
function tabbables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    // Un control oculto con CSS (el "Cerrar" de desktop en el celu) no recibe foco.
    (el) => typeof el.checkVisibility !== 'function' || el.checkVisibility(),
  )
}

/**
 * Dónde tiene que ir el foco para que Tab no se escape de un diálogo modal: del
 * último control al primero, del primero (o del panel mismo) al último. `null`
 * cuando el navegador puede moverlo solo.
 */
export function wrapTab(container: HTMLElement, active: Element | null, backwards: boolean): HTMLElement | null {
  const items = tabbables(container)
  const first = items[0]
  const last = items.at(-1)
  if (!first || !last) return container
  if (!active || !container.contains(active)) return backwards ? last : first
  if (backwards && (active === first || active === container)) return last
  if (!backwards && active === last) return first
  return null
}

// Diálogos con la trampa activa, el de más arriba al final: con una confirmación
// abierta sobre una hoja, Tab sólo recorre la confirmación.
const traps: HTMLElement[] = []

// A nivel documento y no en el panel: si el foco quedó afuera (un `focus()` desde
// otro lado), el Tab igual pasa por acá y vuelve al diálogo.
function onTab(event: KeyboardEvent): void {
  const top = traps.at(-1)
  if (event.key !== 'Tab' || !top) return
  const target = wrapTab(top, document.activeElement, event.shiftKey)
  if (!target) return
  event.preventDefault()
  target.focus()
}

/** Mantiene Tab dentro de `container` hasta que se llame a la función que devuelve. */
export function trapFocus(container: HTMLElement): () => void {
  if (traps.length === 0) document.addEventListener('keydown', onTab)
  traps.push(container)
  return () => {
    const index = traps.lastIndexOf(container)
    if (index !== -1) traps.splice(index, 1)
    if (traps.length === 0) document.removeEventListener('keydown', onTab)
  }
}
