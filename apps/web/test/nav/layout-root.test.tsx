import { render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BottomBar } from '@/components/nav/bottom-bar'
import { TopBar } from '@/components/nav/top-bar'

// Motion mide en coordenadas de página. Un indicador `layoutId` dentro de una barra fija
// o pegajosa sin `layoutRoot` arranca desplazado por todo el scroll cuando Next sube al
// cambiar de pestaña (o el navegador lo restaura al volver). jsdom no tiene layout ni
// scroll que medir, así que se verifica el contrato: cada indicador tiene como raíz de
// layout el contenedor fijo o pegajoso que lo lleva. El prop no llega al DOM: el doble
// de `motion` lo deja a la vista como atributo.
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  const { createElement } = await import('react')
  const wrapped = new Map<PropertyKey, ComponentType<Record<string, unknown>>>()
  const motion = new Proxy(actual.motion, {
    get(target, key) {
      const Original = Reflect.get(target, key) as ComponentType<Record<string, unknown>>
      if (!wrapped.has(key)) {
        wrapped.set(key, (props) =>
          createElement(Original, props.layoutRoot === true ? { ...props, 'data-layout-root': '' } : props),
        )
      }
      return wrapped.get(key)
    },
  })
  return { ...actual, motion }
})

vi.mock('next/navigation', () => ({ usePathname: () => '/posiciones' }))

function indicatorOf(nav: HTMLElement): Element {
  const indicator = nav.querySelector('[aria-current="page"] > [aria-hidden]')
  if (indicator === null) throw new Error('no encontré el indicador de la pestaña activa')
  return indicator
}

describe('indicador de pestaña dentro de barras fijas o pegajosas', () => {
  it('en la barra inferior (fija), la raíz de layout es la barra misma', () => {
    render(<BottomBar base="" />)
    const nav = screen.getByRole('navigation', { name: 'Secciones' })
    expect(nav).toHaveAttribute('data-layout-root')
    expect(indicatorOf(nav).closest('[data-layout-root]')).toBe(nav)
    // `pnpm shots` la oculta por este atributo en las capturas de página completa.
    expect(nav).toHaveAttribute('data-bottom-bar')
  })

  it('en la barra superior (pegajosa), la raíz de layout es la barra entera', () => {
    const { container } = render(<TopBar base="" session={null} />)
    const bar = container.firstElementChild
    expect(bar).toHaveAttribute('data-layout-root')
    const nav = screen.getByRole('navigation', { name: 'Secciones' })
    expect(indicatorOf(nav).closest('[data-layout-root]')).toBe(bar)
  })
})
