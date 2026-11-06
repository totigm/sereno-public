import { render, screen } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AnimatedNumber } from '@/components/ui/number'
import { formatUsd } from '@/lib/format'
import { advance } from '../frames'
import { setReducedMotion } from '../media'
import { expectReducedMotionWarning } from '../motion-warning'

vi.hoisted(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())

const usd = (n: number): string => formatUsd(n)

const shown = (): HTMLElement => screen.getByText(/^US\$/)

describe('AnimatedNumber', () => {
  it('renderiza el valor formateado', () => {
    render(<AnimatedNumber value={1247.8} format={usd} />)
    expect(screen.getByText('US$ 1.247,80')).toBeInTheDocument()
  })

  it('con un cambio mayor al 5% muestra el valor final sin interpolar', () => {
    const { rerender } = render(<AnimatedNumber value={1247.8} format={usd} />)
    rerender(<AnimatedNumber value={2500} format={usd} />)
    expect(screen.getByText('US$ 2.500,00')).toBeInTheDocument()
  })

  it('con un cambio mayor al 5% el reemplazo entra con un fundido de 150 ms', async () => {
    const { rerender } = render(<AnimatedNumber value={1247.8} format={usd} />)
    rerender(<AnimatedNumber value={2500} format={usd} />)
    await advance(64)
    expect(Number(shown().style.opacity)).toBeGreaterThan(0)
    expect(Number(shown().style.opacity)).toBeLessThan(1)
    await advance(150)
    expect(shown().style.opacity).toBe('1')
  })

  it('con un cambio menor al 5% interpola hasta el valor final en 250 ms', async () => {
    const { rerender } = render(<AnimatedNumber value={1247.8} format={usd} />)
    rerender(<AnimatedNumber value={1250} format={usd} />)
    await advance(64)
    // A mitad de camino: ni el valor viejo ni el nuevo.
    expect(shown().textContent).not.toBe('US$ 1.247,80')
    expect(shown().textContent).not.toBe('US$ 1.250,00')
    await advance(400)
    expect(shown().textContent).toBe('US$ 1.250,00')
  })

  it('un cambio chico que llega en pleno fundido no deja el número a media opacidad', async () => {
    const { rerender } = render(<AnimatedNumber value={1247.8} format={usd} />)
    rerender(<AnimatedNumber value={2500} format={usd} />)
    await advance(48)
    rerender(<AnimatedNumber value={2510} format={usd} />)
    await advance(400)
    expect(shown().textContent).toBe('US$ 2.510,00')
    expect(shown().style.opacity).toBe('1')
  })

  describe('con movimiento reducido', () => {
    it('no viaja: muestra el valor final de una y lo funde, sólo con opacidad', async () => {
      const assertWarning = expectReducedMotionWarning()
      setReducedMotion(true)
      const { rerender } = render(<AnimatedNumber value={1247.8} format={usd} />)
      // Un cambio menor al 5%, que sin la preferencia interpolaría.
      rerender(<AnimatedNumber value={1250} format={usd} />)
      expect(shown().textContent).toBe('US$ 1.250,00')

      await advance(64)
      expect(shown().textContent).toBe('US$ 1.250,00')
      expect(Number(shown().style.opacity)).toBeGreaterThan(0)
      expect(Number(shown().style.opacity)).toBeLessThan(1)
      expect(shown().style.transform).toBe('')

      await advance(150)
      expect(shown().style.opacity).toBe('1')
      assertWarning()
    })
  })
})
