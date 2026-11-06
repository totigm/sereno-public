import { describe, it, expect } from 'vitest'
import { BA_TZ, startOfDayBA, formatTimeBA, formatDateBA, sinceLabel, relativeAge } from '../src/time'

const HOUR = 3600e3
const MIN = 60e3
const NOW = Date.UTC(2026, 9, 31, 18, 0) // 15:00 BA del 31 de octubre

describe('BA_TZ', () => {
  it('es la zona de Buenos Aires', () => {
    expect(BA_TZ).toBe('America/Argentina/Buenos_Aires')
  })
})

describe('startOfDayBA', () => {
  it('devuelve las 00:00 BA del día calendario de Buenos Aires', () => {
    // 02:30 UTC del 31 son las 23:30 BA del 30
    expect(startOfDayBA(Date.UTC(2026, 9, 31, 2, 30))).toBe(Date.UTC(2026, 9, 30, 3, 0))
  })
  it('es idempotente en la medianoche exacta', () => {
    const midnight = Date.UTC(2026, 9, 30, 3, 0)
    expect(startOfDayBA(midnight)).toBe(midnight)
    expect(startOfDayBA(midnight - 1)).toBe(Date.UTC(2026, 9, 29, 3, 0))
  })
})

describe('formatTimeBA', () => {
  it('muestra HH:MM en 24 h en hora de Buenos Aires', () => {
    expect(formatTimeBA(Date.UTC(2026, 9, 14, 17, 32))).toBe('14:32')
    expect(formatTimeBA(Date.UTC(2026, 9, 14, 3, 5))).toBe('00:05')
  })
})

describe('formatDateBA', () => {
  it('muestra día y mes en castellano', () => {
    expect(formatDateBA(Date.UTC(2026, 9, 14, 13, 0))).toBe('14 de octubre')
  })
  it('usa el día de Buenos Aires, no el de UTC', () => {
    expect(formatDateBA(Date.UTC(2026, 9, 15, 1, 0))).toBe('14 de octubre')
  })
})

describe('sinceLabel', () => {
  it('hoy muestra la hora', () => {
    expect(sinceLabel(Date.UTC(2026, 9, 31, 13, 15), NOW)).toBe('hoy a las 10:15')
  })
  it('el día anterior dice ayer', () => {
    expect(sinceLabel(Date.UTC(2026, 9, 30, 13, 15), NOW)).toBe('ayer')
  })
  it('antes de ayer muestra la fecha', () => {
    expect(sinceLabel(Date.UTC(2026, 9, 14, 13, 0), NOW)).toBe('el 14 de octubre')
  })
  it('compara días de Buenos Aires: las 23:30 BA de ayer siguen siendo ayer', () => {
    expect(sinceLabel(Date.UTC(2026, 9, 31, 2, 30), NOW)).toBe('ayer')
  })
  it('agrega el año cuando no es el actual', () => {
    expect(sinceLabel(Date.UTC(2025, 11, 20, 15, 0), NOW)).toBe('el 20 de diciembre de 2025')
  })
})

describe('relativeAge', () => {
  it('horas', () => {
    expect(relativeAge(NOW - 3 * HOUR, NOW)).toBe('hace 3 h')
  })
  it('minutos', () => {
    expect(relativeAge(NOW - 20 * MIN, NOW)).toBe('hace 20 min')
    expect(relativeAge(NOW - 59 * MIN - 59e3, NOW)).toBe('hace 59 min')
  })
  it('días, con singular', () => {
    expect(relativeAge(NOW - 2 * 24 * HOUR, NOW)).toBe('hace 2 días')
    expect(relativeAge(NOW - 30 * HOUR, NOW)).toBe('hace 1 día')
  })
  it('menos de un minuto, o un instante futuro por desfase de reloj, es recién', () => {
    expect(relativeAge(NOW - 30e3, NOW)).toBe('recién')
    expect(relativeAge(NOW + 5e3, NOW)).toBe('recién')
  })
})
