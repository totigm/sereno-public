import { describe, it, expect } from 'vitest'
import { EM_DASH, MINUS, formatUsd, formatNumber, formatPct, formatSigned } from '../src/money'

describe('MINUS', () => {
  it('es el signo menos tipográfico U+2212', () => {
    expect(MINUS).toBe('−')
  })
})

const DASH = '—'
const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]

describe('EM_DASH', () => {
  it('es la raya U+2014', () => {
    expect(EM_DASH).toBe('\u2014')
  })
})

describe('formatNumber', () => {
  it('devuelve una raya (U+2014) si el valor no es finito', () => {
    for (const n of NON_FINITE) expect(formatNumber(n)).toBe(DASH)
  })
  it('usa punto de miles y coma decimal, dos decimales por defecto', () => {
    expect(formatNumber(1247.8)).toBe('1.247,80')
    expect(formatNumber(1234567.891)).toBe('1.234.567,89')
  })
  it('respeta la cantidad de decimales pedida', () => {
    expect(formatNumber(0.123456, 4)).toBe('0,1235')
    expect(formatNumber(1247.8, 0)).toBe('1.248')
  })
  it('usa U+2212 para negativos', () => {
    expect(formatNumber(-3.1)).toBe('−3,10')
  })
  it('no muestra "−0,00" cuando un negativo redondea a cero', () => {
    expect(formatNumber(-0.001)).toBe('0,00')
  })
})

describe('formatSigned', () => {
  it('devuelve una raya (U+2014) si el valor no es finito', () => {
    for (const n of NON_FINITE) expect(formatSigned(n)).toBe(DASH)
  })
  it('antepone + a positivos y U+2212 a negativos', () => {
    expect(formatSigned(-3.1, 2)).toBe('−3,10')
    expect(formatSigned(3.1, 2)).toBe('+3,10')
  })
  it('deja el cero sin signo', () => {
    expect(formatSigned(0, 2)).toBe('0,00')
    expect(formatSigned(-0.001, 2)).toBe('0,00')
  })
})

describe('formatUsd', () => {
  it('devuelve una raya (U+2014) si el valor no es finito, con o sin sign y compact', () => {
    for (const n of NON_FINITE) {
      expect(formatUsd(n)).toBe(DASH)
      expect(formatUsd(n, { sign: true })).toBe(DASH)
      expect(formatUsd(n, { compact: true })).toBe(DASH)
      expect(formatUsd(n, { compact: true, sign: true })).toBe(DASH)
    }
  })
  it('formatea en es-AR con prefijo US$', () => {
    expect(formatUsd(1247.8)).toBe('US$ 1.247,80')
  })
  it('con sign muestra + o U+2212 delante del prefijo', () => {
    expect(formatUsd(-3.1, { sign: true })).toBe('−US$ 3,10')
    expect(formatUsd(38.2, { sign: true })).toBe('+US$ 38,20')
  })
  it('sin sign igual muestra el menos de los negativos', () => {
    expect(formatUsd(-3.1)).toBe('−US$ 3,10')
  })
  it('el cero no lleva signo aunque se pida', () => {
    expect(formatUsd(0, { sign: true })).toBe('US$ 0,00')
    expect(formatUsd(-0.004, { sign: true })).toBe('US$ 0,00')
  })
  it('compact abrevia miles y millones con un decimal como máximo', () => {
    expect(formatUsd(1247.8, { compact: true })).toBe('US$ 1,2 k')
    expect(formatUsd(12000, { compact: true })).toBe('US$ 12 k')
    expect(formatUsd(1247800, { compact: true })).toBe('US$ 1,2 M')
    expect(formatUsd(-1247800, { compact: true, sign: true })).toBe('−US$ 1,2 M')
  })
  it('compact deja los montos chicos completos', () => {
    expect(formatUsd(38.2, { compact: true })).toBe('US$ 38,20')
  })
  it('compact pasa a la unidad siguiente cuando el redondeo llega a 1000', () => {
    expect(formatUsd(999_960, { compact: true })).toBe('US$ 1 M')
    expect(formatUsd(999.996, { compact: true })).toBe('US$ 1 k')
  })
  it('compact elige la unidad con el mismo redondeo que el cuerpo', () => {
    // 999.949,9999999999 / 1000 = 999,9499999999999: Intl lo redondea a 999,9 (sigue en k),
    // mientras que Math.round(n × 10) lo empujaba a 1000 y terminaba en "1 M".
    expect(formatUsd(999_949.999_999_999_9, { compact: true })).toBe('US$ 999,9 k')
    expect(formatUsd(999.995, { compact: true })).toBe('US$ 1 k')
  })
  it('compact muestra el menos de los negativos aunque no se pida sign', () => {
    expect(formatUsd(-1247.8, { compact: true })).toBe('−US$ 1,2 k')
    expect(formatUsd(-1247800, { compact: true })).toBe('−US$ 1,2 M')
  })
  it('compact sigue en millones por encima de mil millones', () => {
    expect(formatUsd(1.5e9, { compact: true })).toBe('US$ 1.500 M')
    expect(formatUsd(-2.25e9, { compact: true, sign: true })).toBe('−US$ 2.250 M')
  })
})

describe('formatPct', () => {
  it('devuelve una raya (U+2014) si el valor no es finito, con o sin +', () => {
    for (const n of NON_FINITE) {
      expect(formatPct(n)).toBe(DASH)
      expect(formatPct(n, 1, false)).toBe(DASH)
    }
  })
  it('recibe una fracción y muestra un decimal con signo por defecto', () => {
    expect(formatPct(0.248)).toBe('+24,8%')
    expect(formatPct(-0.009)).toBe('−0,9%')
  })
  it('permite cambiar decimales y omitir el +', () => {
    expect(formatPct(0.248, 0)).toBe('+25%')
    expect(formatPct(0.248, 1, false)).toBe('24,8%')
    expect(formatPct(-0.009, 1, false)).toBe('−0,9%')
  })
  it('el cero no lleva signo', () => {
    expect(formatPct(0)).toBe('0,0%')
    expect(formatPct(-0.0001)).toBe('0,0%')
  })
})
