import { describe, expect, it } from 'vitest'
import { project, rubberband, shouldDismiss, springDefault, springGesture } from '@/lib/motion'

describe('project', () => {
  it('proyecta el punto de reposo con deceleración 0,998', () => {
    expect(project(1000)).toBeCloseTo(499, 6)
    expect(project(-500)).toBeCloseTo(-249.5, 6)
    expect(project(0)).toBe(0)
  })
})

describe('rubberband', () => {
  it('resiste progresivamente con constante 0,55', () => {
    expect(rubberband(100, 600)).toBeCloseTo(33000 / 655, 6)
    expect(rubberband(-100, 600)).toBeCloseTo(-33000 / 655, 6)
    expect(rubberband(0, 600)).toBe(0)
  })

  it('nunca supera la dimensión por más que se arrastre', () => {
    expect(rubberband(100_000, 600)).toBeLessThan(600)
  })
})

describe('springs', () => {
  it('el spring por defecto no rebota y el de gesto rebota 0,2', () => {
    expect(springDefault).toEqual({ type: 'spring', bounce: 0, duration: 0.35 })
    expect(springGesture).toEqual({ type: 'spring', bounce: 0.2, duration: 0.4 })
  })
})

describe('shouldDismiss', () => {
  it('cierra con un tirón hacia abajo de más de 500 px/s aunque esté arriba', () => {
    expect(shouldDismiss(0, 600, 800)).toBe(true)
    expect(shouldDismiss(0, 500, 800)).toBe(false)
  })

  it('quieta, cierra sólo si pasó la mitad del recorrido', () => {
    expect(shouldDismiss(0.4 * 800, 0, 800)).toBe(false)
    expect(shouldDismiss(0.6 * 800, 0, 800)).toBe(true)
  })

  it('suma la proyección de la velocidad a la posición', () => {
    // project(300) = 149,7 px: desde el 30% pasa la mitad de 600 pero no la de 1000.
    expect(shouldDismiss(0.3 * 600, 300, 600)).toBe(true)
    expect(shouldDismiss(0.3 * 1000, 300, 1000)).toBe(false)
  })

  it('un tirón hacia arriba la deja abierta aunque esté casi abajo', () => {
    expect(shouldDismiss(0.6 * 800, -800, 800)).toBe(false)
  })
})
