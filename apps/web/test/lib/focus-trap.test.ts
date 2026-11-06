import { afterEach, describe, expect, it } from 'vitest'
import { trapFocus, wrapTab } from '@/lib/focus-trap'

function panel(html: string): HTMLElement {
  const container = document.createElement('div')
  container.tabIndex = -1
  container.innerHTML = html
  document.body.append(container)
  return container
}

const byText = (container: HTMLElement, text: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('*')].find((el) => el.textContent === text)
  if (!found) throw new Error(`no encontré ${text}`)
  return found
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('wrapTab', () => {
  const html = '<button>Cerrar</button><p>Texto</p><a href="#x">Ver más</a><button disabled>Off</button><button>Pausar</button>'

  it('Tab desde el último vuelve al primero', () => {
    const container = panel(html)
    expect(wrapTab(container, byText(container, 'Pausar'), false)).toBe(byText(container, 'Cerrar'))
  })

  it('Shift+Tab desde el primero, o desde el panel, va al último', () => {
    const container = panel(html)
    expect(wrapTab(container, byText(container, 'Cerrar'), true)).toBe(byText(container, 'Pausar'))
    expect(wrapTab(container, container, true)).toBe(byText(container, 'Pausar'))
  })

  it('en el medio deja que el navegador mueva el foco', () => {
    const container = panel(html)
    expect(wrapTab(container, byText(container, 'Ver más'), false)).toBeNull()
    expect(wrapTab(container, byText(container, 'Ver más'), true)).toBeNull()
  })

  it('si el foco quedó afuera, lo trae adentro', () => {
    const container = panel(html)
    const outside = document.createElement('button')
    document.body.append(outside)
    expect(wrapTab(container, outside, false)).toBe(byText(container, 'Cerrar'))
  })

  it('sin nada enfocable, el foco se queda en el panel', () => {
    const container = panel('<p>Sólo texto</p>')
    expect(wrapTab(container, container, false)).toBe(container)
  })
})

describe('trapFocus', () => {
  // Un Tab real: sale del elemento con foco y burbujea hasta el documento.
  function pressTab(): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    ;(document.activeElement ?? document.body).dispatchEvent(event)
    return event
  }

  function outsideButton(): HTMLButtonElement {
    const outside = document.createElement('button')
    document.body.append(outside)
    return outside
  }

  it('con el foco afuera, Tab lo devuelve al diálogo', () => {
    const container = panel('<button>Cerrar</button><button>Pausar</button>')
    const release = trapFocus(container)
    outsideButton().focus()
    expect(pressTab().defaultPrevented).toBe(true)
    expect(byText(container, 'Cerrar')).toHaveFocus()
    release()
  })

  it('con dos trampas manda la de arriba; al soltarla vuelve a mandar la de abajo', () => {
    const below = panel('<button>Abajo</button>')
    const above = panel('<button>Arriba</button>')
    const releaseBelow = trapFocus(below)
    const releaseAbove = trapFocus(above)
    byText(below, 'Abajo').focus()
    pressTab()
    expect(byText(above, 'Arriba')).toHaveFocus()

    releaseAbove()
    pressTab()
    expect(byText(below, 'Abajo')).toHaveFocus()
    releaseBelow()
  })

  it('soltar la de abajo primero deja mandando a la de arriba', () => {
    const below = panel('<button>Abajo</button>')
    const above = panel('<button>Arriba</button>')
    const releaseBelow = trapFocus(below)
    const releaseAbove = trapFocus(above)
    releaseBelow()
    byText(below, 'Abajo').focus()
    pressTab()
    expect(byText(above, 'Arriba')).toHaveFocus()
    releaseAbove()
  })

  it('soltadas todas, Tab no se toca', () => {
    trapFocus(panel('<button>Cerrar</button>'))()
    const outside = outsideButton()
    outside.focus()
    expect(pressTab().defaultPrevented).toBe(false)
    expect(outside).toHaveFocus()
  })
})
