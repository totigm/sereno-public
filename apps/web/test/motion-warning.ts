import { expect, onTestFinished, vi } from 'vitest'

// Motion avisa una vez por archivo de tests, la primera vez que un componente lee el
// movimiento reducido activado. En los tests que lo activan a propósito el aviso es
// esperado: se silencia y se comprueba que fue sólo ése, así un aviso real no se esconde.
const REDUCED_MOTION_WARNING = 'You have Reduced Motion enabled on your device'

export function expectReducedMotionWarning(): () => void {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => warn.mockRestore())
  return () => {
    expect(warn.mock.calls).toEqual([[expect.stringContaining(REDUCED_MOTION_WARNING)]])
  }
}
