import type { Page } from 'playwright'

// Antes de capturar: red quieta, fuentes cargadas, animaciones de entrada terminadas
// y el DOM sin cambios por un momento (los datos que llegan después del primer pintado).

const QUIET_MS = 400
const MAX_WAIT_MS = 5_000

// Va como texto: tsx compila con `keepNames` y una función pasada a `evaluate`
// llegaría al navegador llamando a un `__name` que ahí no existe.
const IN_PAGE = `(async () => {
  await document.fonts.ready
  // Las infinitas (un spinner) no terminan nunca: no se esperan.
  const finite = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
  await Promise.race([
    Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, ${MAX_WAIT_MS})),
  ])
  await new Promise((resolve) => {
    let timer
    let limit
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(finish, ${QUIET_MS})
    })
    const finish = () => {
      observer.disconnect()
      clearTimeout(timer)
      clearTimeout(limit)
      resolve(undefined)
    }
    timer = setTimeout(finish, ${QUIET_MS})
    limit = setTimeout(finish, ${MAX_WAIT_MS})
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })
})()`

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  await page.evaluate(IN_PAGE)
}
