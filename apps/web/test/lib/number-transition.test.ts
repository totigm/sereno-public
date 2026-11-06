import { describe, expect, it } from 'vitest'
import { shouldInterpolate } from '@/lib/number-transition'
import { VisibilityLog } from '@/lib/visibility'

describe('shouldInterpolate', () => {
  const base = { visibleRecently: true, reducedMotion: false }

  it('interpola cuando el cambio es menor al 5% del valor anterior', () => {
    expect(shouldInterpolate({ from: 1247.8, to: 1250, ...base })).toBe(true)
    expect(shouldInterpolate({ from: 100, to: 104.9, ...base })).toBe(true)
  })

  it('no interpola a partir del 5%', () => {
    expect(shouldInterpolate({ from: 1247.8, to: 2500, ...base })).toBe(false)
    expect(shouldInterpolate({ from: 100, to: 105, ...base })).toBe(false)
  })

  it('no interpola desde cero ni al cruzar cero', () => {
    expect(shouldInterpolate({ from: 0, to: 0.1, ...base })).toBe(false)
    expect(shouldInterpolate({ from: 1, to: -1, ...base })).toBe(false)
  })

  it('no interpola si la pestaña no estuvo visible o se pidió menos movimiento', () => {
    expect(shouldInterpolate({ from: 1247.8, to: 1250, visibleRecently: false, reducedMotion: false })).toBe(false)
    expect(shouldInterpolate({ from: 1247.8, to: 1250, visibleRecently: true, reducedMotion: true })).toBe(false)
  })
})

describe('VisibilityLog', () => {
  it('estuvo visible en los últimos 30 s si lo estaba hace 30 s y ahora', () => {
    const log = new VisibilityLog(true)
    expect(log.wasVisibleRecently(60_000)).toBe(true)
  })

  it('tolera una ausencia corta', () => {
    const log = new VisibilityLog(true)
    log.record(false, 100_000)
    log.record(true, 105_000)
    expect(log.wasVisibleRecently(110_000)).toBe(true)
  })

  it('no cuenta como reciente después de una ausencia larga', () => {
    const log = new VisibilityLog(true)
    log.record(false, 100_000)
    log.record(true, 150_000)
    expect(log.wasVisibleRecently(155_000)).toBe(false)
    expect(log.wasVisibleRecently(181_000)).toBe(true)
  })

  it('al descartar transiciones viejas conserva el estado que dejaron', () => {
    // Arranca oculta y se hace visible; después alterna rápido hasta llenar el historial.
    const log = new VisibilityLog(false)
    log.record(true, 1_000)
    for (let i = 0; i < 16; i += 1) log.record(i % 2 === 0, 200_000 + i * 100)
    // A los 100 s la pestaña estaba visible: lo dijo la primera transición, ya descartada.
    expect(log.visibleAt(100_000)).toBe(true)
  })

  it('nunca es reciente mientras la pestaña está oculta', () => {
    const log = new VisibilityLog(true)
    log.record(false, 100_000)
    expect(log.wasVisibleRecently(101_000)).toBe(false)
  })
})
