// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DESKTOP_QUERY, themeColor, tokens } from '@/lib/theme'

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8')

describe('tokens', () => {
  it('son exactamente los de la spec 11.2', () => {
    expect(tokens.light).toEqual({
      bg: '#EDF0F4',
      surface: '#FFFFFF',
      ink: '#17202A',
      muted: '#6B7482',
      line: '#DFE3E8',
      gain: '#2E8B6A',
      loss: '#C4553D',
      gainSoft: '#E1EEE8',
      lossSoft: '#F5E5E1',
    })
    expect(tokens.dark).toEqual({
      bg: '#0F1318',
      surface: '#171C24',
      ink: '#E8ECF1',
      muted: '#8A93A3',
      line: '#262D38',
      gain: '#4FD1A5',
      loss: '#FF7A7A',
      gainSoft: 'rgba(79,209,165,.14)',
      lossSoft: 'rgba(255,122,122,.14)',
    })
  })

  it('globals.css declara los mismos valores como custom properties', () => {
    for (const scheme of [tokens.light, tokens.dark]) {
      for (const value of Object.values(scheme)) {
        expect(css).toContain(value)
      }
    }
    for (const name of ['--bg', '--surface', '--ink', '--muted', '--line', '--gain', '--loss', '--gain-soft', '--loss-soft']) {
      expect(css).toMatch(new RegExp(`${name}:`))
    }
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('--color-surface: var(--surface)')
  })

  it('el velo de las hojas oscurece en los dos esquemas: no sale de --ink, que en oscuro es casi blanco', () => {
    const [light, dark] = css.split('@media (prefers-color-scheme: dark)')
    expect(light).toMatch(/--scrim: rgba\(23, 32, 42, 0\.4\);/)
    expect(dark).toMatch(/--scrim: rgba\(0, 0, 0, 0\.6\);/)
    expect(css).toContain('--color-scrim: var(--scrim)')
  })

  it('el theme-color sigue al esquema y desktop arranca en 900px', () => {
    expect(themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: '#EDF0F4' },
      { media: '(prefers-color-scheme: dark)', color: '#0F1318' },
    ])
    expect(DESKTOP_QUERY).toBe('(min-width: 900px)')
  })
})
