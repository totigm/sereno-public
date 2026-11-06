import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Segment } from '@/components/ui/segment'
import { Toggle } from '@/components/ui/toggle'

// Objetivos táctiles de 44 px sin agrandar lo visual: el control conserva su alto y un
// pseudo-elemento amplía el área que recibe el toque (jsdom no mide: se fijan las clases).

describe('Toggle', () => {
  it('el switch mide 28 px a la vista y 44 px al tacto', () => {
    render(<Toggle checked={false} onChange={() => {}} label="Reinvertir ganancias" />)
    const control = screen.getByRole('switch', { name: 'Reinvertir ganancias' })
    expect(control).toHaveClass('h-7', 'relative', "after:content-['']", 'after:absolute', 'after:-inset-2')
  })

  it('tocar la etiqueta o la descripción lo activa', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [checked, setChecked] = useState(false)
      return <Toggle checked={checked} onChange={setChecked} label="Trailing stop" description="El stop sigue al mejor precio." />
    }
    render(<Harness />)
    const control = screen.getByRole('switch', { name: 'Trailing stop' })
    await user.click(screen.getByText('Trailing stop'))
    expect(control).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByText('El stop sigue al mejor precio.'))
    expect(control).toHaveAttribute('aria-checked', 'false')
    // Tocar el switch en sí cambia una sola vez.
    await user.click(control)
    expect(control).toHaveAttribute('aria-checked', 'true')
  })

  it('deshabilitado, tocar la etiqueta no hace nada', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} label="Congelar aprendizaje" disabled />)
    await user.click(screen.getByText('Congelar aprendizaje'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Segment', () => {
  it('cada opción mide 32 px a la vista y 44 px al tacto', () => {
    render(<Segment label="Rango" options={[{ value: 'd', label: 'Día' }, { value: 's', label: 'Semana' }]} value="d" onChange={() => {}} />)
    for (const option of screen.getAllByRole('radio')) {
      expect(option).toHaveClass('h-8', 'relative', "after:content-['']", 'after:absolute', 'after:inset-x-0', 'after:-inset-y-1.5')
    }
  })
})
