import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { customMargin, exitTranslation, liquidationDistance, liquidationWarning, tradableSymbols, worstMmr } from '@/components/ajustes/custom-math'
import { glue } from '@/components/ajustes/glue'
import { shieldPreview } from '@/components/ajustes/live-preview'
import { formatValue, parseInput, toInput } from '@/components/ajustes/units'
import { universeOutPhrase } from '@/components/ajustes/universe-reasons'
import { validatePatch } from '@/components/ajustes/validation'

describe('unidades de los campos', () => {
  it('los porcentajes se escriben en puntos y se guardan como fracción, sin ruido de coma flotante', () => {
    expect(toInput(0.07, 'pct')).toBe('7')
    expect(toInput(0.0005, 'pct')).toBe('0,05')
    expect(parseInput('2,5', 'pct')).toBe(0.025)
    expect(parseInput(' 7 ', 'pct')).toBe(0.07)
    expect(parseInput('0.05', 'pct')).toBe(0.0005)
  })

  it('lo que no es un número es null', () => {
    expect(parseInput('', 'count')).toBeNull()
    expect(parseInput('abc', 'usd')).toBeNull()
    expect(parseInput('1,2,3', 'usd')).toBeNull()
  })

  it('formatea cada unidad como se lee en la pantalla', () => {
    expect(formatValue(0.0005, 'pct')).toBe('0,05%')
    expect(formatValue(0.7, 'pct')).toBe('70%')
    expect(formatValue(50, 'usd')).toBe('US$ 50')
    expect(formatValue(5, 'leverage')).toBe('5x')
    expect(formatValue(4, 'hours')).toBe('4 h')
    expect(formatValue(3, 'multiple')).toBe('3 veces el capital')
    expect(formatValue(30, 'count')).toBe('30')
  })
})

describe('validación con SettingsSchema', () => {
  it('traduce los límites del esquema a la unidad del campo', () => {
    const capital = (protectPct: number) => ({ capital: { ...DEFAULT_SETTINGS.capital, protectPct } })
    expect(validatePatch(DEFAULT_SETTINGS, capital(1.5), 'pct')).toBe('Como máximo 100%.')
    expect(validatePatch(DEFAULT_SETTINGS, capital(0.5), 'pct')).toBeNull()
    expect(validatePatch(DEFAULT_SETTINGS, { custom: { ...DEFAULT_SETTINGS.custom, leverage: 25 } }, 'leverage')).toBe('Como máximo 20x.')
    expect(validatePatch(DEFAULT_SETTINGS, { custom: { ...DEFAULT_SETTINGS.custom, leverage: 2.5 } }, 'leverage')).toBe(
      'Tiene que ser un número entero.',
    )
    expect(validatePatch(DEFAULT_SETTINGS, { custom: { ...DEFAULT_SETTINGS.custom, slPct: 0 } }, 'pct')).toBe(
      'Tiene que ser mayor que 0%.',
    )
    expect(validatePatch(DEFAULT_SETTINGS, { risk: { ...DEFAULT_SETTINGS.risk, maxSameDirection: 0 } }, 'count')).toBe('Como mínimo 1.')
  })
})

describe('modo "Yo fijo tamaño y salidas"', () => {
  it('el margen sale en dólares o como porcentaje del capital base', () => {
    expect(customMargin({ kind: 'usd', value: 50 }, 1000)).toBe(50)
    expect(customMargin({ kind: 'pct', value: 0.1 }, 1312)).toBeCloseTo(131.2)
  })

  it('traduce TP y SL a dólares y a porcentaje del margen', () => {
    expect(exitTranslation('sl', 0.02, 50, 5)).toBe('SL 2% del precio = −US$ 5 de los US$ 50 (−10%)')
    expect(exitTranslation('tp', 0.04, 50, 5)).toBe('TP 4% del precio = +US$ 10 de los US$ 50 (+20%)')
    expect(exitTranslation('sl', 0.025, 40, 3)).toBe('SL 2,5% del precio = −US$ 3 de los US$ 40 (−7,5%)')
    // Sin capital para calcular el margen, sólo el porcentaje.
    expect(exitTranslation('sl', 0.02, 0, 5)).toBe('SL 2% del precio = −10% del margen')
  })

  it('con el SL más allá de la liquidación no promete una pérdida mayor al margen: dice que liquida antes', () => {
    const liquidation = liquidationDistance(10, 0.02, 'both')
    expect(exitTranslation('sl', 0.12, 105.78, 10, liquidation)).toBe(
      'SL 12% del precio: antes te liquidan, a 7,8% del precio, y perdés los US$ 105,78 del margen',
    )
    expect(exitTranslation('sl', 0.12, 0, 10, liquidation)).toBe('SL 12% del precio: antes te liquidan, a 7,8% del precio, y perdés el margen')
    // Antes de la liquidación sigue la cuenta de siempre; el TP no se liquida.
    expect(exitTranslation('sl', 0.05, 50, 10, liquidation)).toBe('SL 5% del precio = −US$ 25 de los US$ 50 (−50%)')
    expect(exitTranslation('tp', 0.12, 50, 10, liquidation)).toBe('TP 12% del precio = +US$ 60 de los US$ 50 (+120%)')
  })

  it('las monedas que pueden operar son las del tablero y las abiertas, sin repetir', () => {
    const market = { symbols: [{ symbol: 'BTCUSDT' }, { symbol: 'SOLUSDT' }] }
    expect(tradableSymbols({ market, open: [{ symbol: 'SOLUSDT' }, { symbol: 'AVAXUSDT' }] })).toEqual(['BTCUSDT', 'SOLUSDT', 'AVAXUSDT'])
    expect(tradableSymbols({ market: null, open: [] })).toEqual([])
  })

  it('el peor mmr es el de las monedas que pueden operar, y el de por defecto entra siempre', () => {
    // Con la clave de Binance la tabla trae todas las perpetuas, también las que el universo no opera.
    const risk = { mmrBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.005, NEWUSDT: 0.025 }, mmrDefault: 0.02 }
    expect(worstMmr(DEFAULT_SETTINGS.risk, [])).toBe(0.02)
    expect(worstMmr(risk, ['BTCUSDT', 'ETHUSDT'])).toBe(0.02)
    expect(worstMmr(risk, ['BTCUSDT', 'NEWUSDT'])).toBe(0.025)
    // Una moneda fuera de la tabla usa el de por defecto.
    expect(worstMmr({ ...risk, mmrDefault: 0.03 }, ['SOLUSDT'])).toBe(0.03)
  })

  it('la distancia a la liquidación es la del lado que liquida más cerca entre los permitidos', () => {
    // Long 10x con mmr 2%: 1 − 0,9 / 0,98 ≈ 8,16%; short: 1,1 / 1,02 − 1 ≈ 7,84%.
    expect(liquidationDistance(10, 0.02, 'long')).toBeCloseTo(0.08163, 4)
    expect(liquidationDistance(10, 0.02, 'short')).toBeCloseTo(0.07843, 4)
    expect(liquidationDistance(10, 0.02, 'both')).toBeCloseTo(0.07843, 4)
  })

  it('avisa sólo cuando el SL queda más allá de la liquidación', () => {
    const custom = { ...DEFAULT_SETTINGS.custom, leverage: 10 }
    const risk = DEFAULT_SETTINGS.risk
    expect(liquidationWarning({ ...custom, slPct: 0.12 }, risk, [])).toBe(
      'Con 10x te liquidan a 7,8% del precio (mmr de 2%), antes del SL: bajá el SL o el apalancamiento.',
    )
    expect(liquidationWarning({ ...custom, slPct: 0.07 }, risk, [])).toBeNull()
    // Sólo long: la liquidación del long está más lejos (8,2%), así que un SL de 8% entra.
    expect(liquidationWarning({ ...custom, slPct: 0.08, direction: 'long' }, risk, [])).toBeNull()
    expect(liquidationWarning({ ...custom, slPct: 0.08, direction: 'both' }, risk, [])).not.toBeNull()
  })

  it('una moneda de la tabla que no puede operar no bloquea: el bot valida cada entrada con el mmr de su moneda', () => {
    // 10x y SL 7,5%: con mmr 2% el short liquida a 7,84% (entra); con 2,5%, a 7,32% (no).
    const custom = { ...DEFAULT_SETTINGS.custom, leverage: 10, slPct: 0.075 }
    const risk = { ...DEFAULT_SETTINGS.risk, mmrBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.005, NEWUSDT: 0.025 } }
    expect(liquidationWarning(custom, risk, ['BTCUSDT', 'ETHUSDT'])).toBeNull()
    expect(liquidationWarning(custom, risk, ['BTCUSDT', 'NEWUSDT'])).toBe(
      'Con 10x te liquidan a 7,3% del precio (mmr de 2,5%), antes del SL: bajá el SL o el apalancamiento.',
    )
  })
})

describe('vista previa del blindaje', () => {
  const basis = { capitalInicial: 1000, baseBlindaje: 1000 }

  it('con la base en el capital inicial', () => {
    expect(shieldPreview(0.7, basis)).toBe(
      'Cuando la ganancia llegue a 70% (US$ 700), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado.',
    )
  })

  it('después de volver a usar el capital, mide la ganancia nueva desde la base nueva', () => {
    expect(shieldPreview(0.5, { capitalInicial: 1000, baseBlindaje: 1312 })).toBe(
      'Cuando la ganancia nueva llegue a 50% (US$ 656), blindo US$ 1.312 y sigo sólo con lo ganado.',
    )
  })

  it('en cero no hay blindaje', () => {
    expect(shieldPreview(0, basis)).toBe('Sin blindaje: el bot opera con todo el capital, también con el inicial.')
  })
})

describe('monedas fuera del universo', () => {
  it('explica cada motivo en una frase', () => {
    expect(universeOutPhrase('ETHUSDT', { reason: 'below_min_notional', detail: '20' })).toBe(
      'ETH: el mínimo de Binance es US$ 20, más de lo que permite tu capital.',
    )
    expect(universeOutPhrase('NEWUSDT', { reason: 'history', detail: '2026-10-15', pinned: true })).toBe(
      'NEW: fijada, pero tiene menos historia que la pedida.',
    )
    expect(universeOutPhrase('XAUUSDT', { reason: 'tradfi' })).toBe('XAU: es TradFi y no está incluido.')
  })
})

describe('texto en pantalla', () => {
  it('no corta "US$" de su número ni "24 h" al final de una línea', () => {
    expect(glue('Blindo los US$ 1.000 iniciales, −US$ 5 en 24 h.')).toBe('Blindo los US$ 1.000 iniciales, −US$ 5 en 24 h.')
    expect(glue('Sin montos.')).toBe('Sin montos.')
  })
})
