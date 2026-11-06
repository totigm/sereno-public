import { act } from '@testing-library/react'
import { vi } from 'vitest'

// Motion toma `requestAnimationFrame` al cargarse: un test que quiera manejar
// el tiempo de las animaciones instala el reloj falso antes de importar los
// componentes, con `vi.hoisted(() => vi.useFakeTimers())` al principio del archivo.

/** Avanza el reloj falso dentro de `act`: corren los cuadros de Motion y los renders que disparan. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
