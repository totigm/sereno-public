import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from '@/components/ui/button'

// El blanco sobre `loss` puro da 4,45:1 en claro y la etiqueta de 15 px pide 4,5. El
// botón destructivo usa el mismo relleno oscurecido que la marca de la plata real (5,1:1);
// en oscuro sigue `loss` con texto `bg` (jsdom no calcula colores: se fijan las clases).
describe('botón danger', () => {
  it('lleva el rojo oscurecido en claro y loss en oscuro', () => {
    render(<Button variant="danger">Cerrar todo y apagar</Button>)
    const button = screen.getByRole('button', { name: 'Cerrar todo y apagar' })
    expect(button).toHaveClass('bg-[color-mix(in_srgb,var(--loss)_90%,var(--ink))]', 'text-surface', 'dark:bg-loss', 'dark:text-bg')
    expect(button).not.toHaveClass('bg-loss')
  })
})
