import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sheet } from '@/components/ui/sheet'
import { ToastProvider, useToast } from '@/components/ui/toast'

// El z-index de la capa fija que contiene a `el` (la clase `z-50` o `z-[60]` de Tailwind).
function layerOf(el: HTMLElement): number {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (!node.classList.contains('fixed')) continue
    const match = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(node.className)
    if (match) return Number(match[1] ?? match[2])
  }
  throw new Error('sin capa fija con z-index')
}

function SheetWithUndo() {
  const toast = useToast()
  return (
    <Sheet open onClose={() => {}} title="SOL">
      <button type="button" onClick={() => toast({ message: 'Fijaste SOL.', undo: () => {} })}>
        Fijar
      </button>
    </Sheet>
  )
}

describe('toasts y hojas', () => {
  it('un "Deshacer" disparado desde una hoja abierta queda por encima de la hoja', () => {
    render(
      <ToastProvider>
        <SheetWithUndo />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fijar' }))
    const undo = screen.getByRole('button', { name: 'Deshacer' })
    expect(layerOf(undo)).toBeGreaterThan(layerOf(screen.getByRole('dialog', { name: 'SOL' })))
  })
})
