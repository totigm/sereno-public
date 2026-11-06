'use client'

import { useEffect, useState } from 'react'
import { useMediaQuery } from '@/lib/use-media-query'
import { tokens } from '@/lib/theme'

export interface ChartPalette {
  surface: string
  ink: string
  muted: string
  line: string
  gain: string
  loss: string
  font: string
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

const FALLBACK: ChartPalette = { ...tokens.light, font: 'ui-sans-serif, system-ui, sans-serif' }

function read(): ChartPalette {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback
  return {
    surface: token('--surface', FALLBACK.surface),
    ink: token('--ink', FALLBACK.ink),
    muted: token('--muted', FALLBACK.muted),
    line: token('--line', FALLBACK.line),
    gain: token('--gain', FALLBACK.gain),
    loss: token('--loss', FALLBACK.loss),
    font: getComputedStyle(document.body).fontFamily || FALLBACK.font,
  }
}

/**
 * Los colores de los tokens CSS (`app/globals.css`) para lo que dibuja en un canvas:
 * se leen al montar y otra vez cuando el sistema pasa de claro a oscuro.
 */
export function useChartPalette(): ChartPalette | null {
  const dark = useMediaQuery(DARK_QUERY)
  const [palette, setPalette] = useState<ChartPalette | null>(null)
  useEffect(() => {
    setPalette(read())
  }, [dark])
  return palette
}
