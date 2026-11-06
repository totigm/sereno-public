import { describe, expect, it } from 'vitest'
import {
  phraseAccountRule,
  phraseClose,
  phraseLiquidation,
  phraseOpen,
  phraseShadowDrawdown,
  phraseShield,
  phraseStopMoved,
  phraseWait,
} from '../../src/journal/phrases'
import { closed, composite, position, signal, T0 } from './fixtures'

describe('phraseOpen', () => {
  it('arma la frase del brief con las dos señales de mayor |valor × peso| a favor', () => {
    const c = composite({
      signals: [
        signal('trendHigher', 1),
        signal('funding', 0.5),
        signal('momentum', 0.3),
        signal('bands', -0.9), // en contra del long: no entra aunque pese mucho
        signal('btcRegime', null),
      ],
      weights: { funding: 1.4, bands: 2 },
    })
    expect(phraseOpen(position(), c)).toBe(
      'Abrí un long 5x en SOL con US$ 50. La tendencia en 1h y 4h acompaña y el funding está negativo.',
    )
  })

  it('ordena por |valor × peso|: un peso alto puede ganarle a un valor alto', () => {
    const c = composite({
      signals: [signal('trendHigher', 1), signal('funding', 0.5), signal('momentum', 0.6)],
      weights: { momentum: 2, funding: 1.1 },
    })
    expect(phraseOpen(position(), c)).toBe(
      'Abrí un long 5x en SOL con US$ 50. El momentum empuja para arriba y la tendencia en 1h y 4h acompaña.',
    )
  })

  it('en un short entran las señales negativas y se dicen en su sentido', () => {
    const c = composite({
      signals: [signal('trendHigher', -1), signal('funding', -0.5), signal('momentum', 0.9)],
    })
    expect(phraseOpen(position({ symbol: 'INJUSDT', side: 'short', leverage: 3, margin: 20 }), c)).toBe(
      'Abrí un short 3x en INJ con US$ 20. La tendencia en 1h y 4h acompaña y el funding está positivo.',
    )
  })

  it('con una sola señal a favor hay una sola razón; sin ninguna, una frase genérica', () => {
    expect(phraseOpen(position(), composite({ signals: [signal('breakout', 1), signal('vwap', -0.5)] }))).toBe(
      'Abrí un long 5x en SOL con US$ 50. Rompió el máximo de las últimas 20 velas.',
    )
    expect(phraseOpen(position(), composite({ signals: [signal('vwap', -0.5)] }))).toBe(
      'Abrí un long 5x en SOL con US$ 50. Las señales en conjunto dieron para entrar.',
    )
  })

  it('el margen con centavos se muestra con dos decimales', () => {
    expect(phraseOpen(position({ margin: 37.5 }), composite())).toContain('con US$ 37,50.')
  })
})

describe('phraseClose', () => {
  it('take profit: frase exacta del brief', () => {
    expect(phraseClose(closed())).toBe('Cerré el long en SOL en el take profit: +US$ 12,40 (+2,0R).')
  })

  it('stop y trailing con pérdida llevan el menos tipográfico', () => {
    expect(phraseClose(closed({ closeReason: 'stop', pnlNet: -6.2, rMultiple: -1 }))).toBe(
      'Cerré el long en SOL en el stop: −US$ 6,20 (−1,0R).',
    )
    expect(phraseClose(closed({ closeReason: 'trailing_stop', pnlNet: 8.06, rMultiple: 1.3 }))).toBe(
      'Cerré el long en SOL en el trailing stop: +US$ 8,06 (+1,3R).',
    )
  })

  it('liquidación: frase exacta del brief, también vía phraseLiquidation', () => {
    const p = closed({ symbol: 'INJUSDT', side: 'short', closeReason: 'liquidation', margin: 50, pnlNet: -50, rMultiple: -8 })
    expect(phraseClose(p)).toBe('Me liquidaron el short en INJ: perdí los US$ 50 de margen.')
    expect(phraseLiquidation(p)).toBe('Me liquidaron el short en INJ: perdí los US$ 50 de margen.')
  })

  it('stop no ejecutado por bot sin conexión: frase exacta del brief', () => {
    expect(phraseClose(closed({ closeReason: 'stop_missed_offline', pnlNet: -7.1, rMultiple: -1.15 }))).toBe(
      'Cerré el long en SOL al reconectar: el stop había quedado atrás mientras estaba sin conexión (−US$ 7,10).',
    )
  })

  it('salida por tiempo dice las horas que pasaron', () => {
    const p = closed({ closeReason: 'time_exit', closedAt: T0 + 48 * 3_600_000, pnlNet: 1.1, rMultiple: 0.18 })
    expect(phraseClose(p)).toBe('Cerré el long en SOL a las 48 horas sin despegar: +US$ 1,10 (+0,2R).')
  })

  it('salida por tiempo: una hora en singular, horas con minutos y menos de una hora', () => {
    const after = (minutes: number) => closed({ closeReason: 'time_exit', closedAt: T0 + minutes * 60_000, pnlNet: 1.1, rMultiple: 0.18 })
    expect(phraseClose(after(60))).toBe('Cerré el long en SOL a la hora sin despegar: +US$ 1,10 (+0,2R).')
    expect(phraseClose(after(90))).toBe('Cerré el long en SOL a la hora y media sin despegar: +US$ 1,10 (+0,2R).')
    expect(phraseClose(after(135))).toBe('Cerré el long en SOL a las 2 horas y 15 minutos sin despegar: +US$ 1,10 (+0,2R).')
    expect(phraseClose(after(61))).toBe('Cerré el long en SOL a la hora y 1 minuto sin despegar: +US$ 1,10 (+0,2R).')
    expect(phraseClose(after(45))).toBe('Cerré el long en SOL a los 45 minutos sin despegar: +US$ 1,10 (+0,2R).')
    expect(phraseClose(after(1))).toBe('Cerré el long en SOL al minuto sin despegar: +US$ 1,10 (+0,2R).')
  })

  it('el resto de los motivos tiene su frase', () => {
    const base = { pnlNet: 3, rMultiple: 0.5 } as const
    expect(phraseClose(closed({ ...base, closeReason: 'signal_flip' }))).toBe(
      'Cerré el long en SOL porque las señales se dieron vuelta: +US$ 3,00 (+0,5R).',
    )
    expect(phraseClose(closed({ ...base, closeReason: 'manual' }))).toBe(
      'Cerré el long en SOL porque me lo pediste: +US$ 3,00 (+0,5R).',
    )
    expect(phraseClose(closed({ ...base, closeReason: 'close_all' }))).toBe(
      'Cerré el long en SOL al cerrar todo: +US$ 3,00 (+0,5R).',
    )
    expect(phraseClose(closed({ ...base, closeReason: 'shield_reduce' }))).toBe(
      'Cerré el long en SOL para blindar el capital inicial: +US$ 3,00 (+0,5R).',
    )
    expect(phraseClose(closed({ ...base, closeReason: 'delisted' }))).toBe(
      'Cerré el long en SOL porque el contrato se deslista: +US$ 3,00 (+0,5R).',
    )
    expect(phraseClose(closed({ ...base, closeReason: 'session_archived' }))).toBe(
      'Cerré el long en SOL al archivar la simulación: +US$ 3,00 (+0,5R).',
    )
  })

  it('un resultado de cero no lleva signo', () => {
    expect(phraseClose(closed({ closeReason: 'manual', pnlNet: 0, rMultiple: 0 }))).toBe(
      'Cerré el long en SOL porque me lo pediste: US$ 0,00 (0,0R).',
    )
  })
})

describe('phraseStopMoved', () => {
  it('subir, bajar y mover a la entrada', () => {
    expect(phraseStopMoved(position(), 138.5, 142.1)).toBe('Moví el stop del long en SOL a la entrada (142,10).')
    expect(phraseStopMoved(position(), 142.1, 145.3)).toBe('Subí el stop del long en SOL de 142,10 a 145,30.')
    const short = position({ symbol: 'INJUSDT', side: 'short', entryPrice: 20.5 })
    expect(phraseStopMoved(short, 21.2, 20.9)).toBe('Bajé el stop del short en INJ de 21,20 a 20,90.')
  })

  it('los precios chicos conservan sus decimales significativos', () => {
    const p = position({ symbol: 'PEPEUSDT', entryPrice: 0.0000123 })
    expect(phraseStopMoved(p, 0.0000118, 0.0000121)).toBe('Subí el stop del long en PEPE de 0,0000118 a 0,0000121.')
  })

  it('un movimiento más chico que los decimales habituales suma decimales hasta que se note', () => {
    const p = position({ symbol: 'SUIUSDT', entryPrice: 3.3 })
    expect(phraseStopMoved(p, 3.4561, 3.4564)).toBe('Subí el stop del long en SUI de 3,4561 a 3,4564.')
    expect(phraseStopMoved(p, 3.45, 3.4504)).toBe('Subí el stop del long en SUI de 3,45 a 3,4504.')
  })
})

describe('phraseWait', () => {
  it('volumen: frase exacta del brief', () => {
    expect(phraseWait('SUIUSDT', 'low_volume', composite())).toBe(
      'Miré SUI y esperé: la inclinación es fuerte pero el volumen no acompaña.',
    )
  })

  it('tendencia mayor en contra', () => {
    expect(phraseWait('SUIUSDT', 'higher_trend_against', composite())).toBe(
      'Miré SUI y esperé: la inclinación es fuerte pero la tendencia en 1h y 4h va en contra.',
    )
  })

  it('concentración por dirección usa el lado que quería', () => {
    expect(phraseWait('SUIUSDT', 'max_same_direction', composite({ Sprime: 0.5 }))).toBe(
      'Miré SUI y esperé: ya tengo el máximo de longs abiertos.',
    )
    expect(phraseWait('SUIUSDT', 'max_same_direction', composite({ Sprime: -0.5 }))).toBe(
      'Miré SUI y esperé: ya tengo el máximo de shorts abiertos.',
    )
  })

  it('el lado que quería la decisión manda sobre el signo de S\'', () => {
    expect(phraseWait('SUIUSDT', 'max_same_direction', composite({ Sprime: 0 }), 'short')).toBe(
      'Miré SUI y esperé: ya tengo el máximo de shorts abiertos.',
    )
    expect(phraseWait('SUIUSDT', 'direction_not_allowed', composite({ Sprime: -0.01 }), 'long')).toBe(
      'Miré SUI y esperé: me pediste que no abra longs.',
    )
    expect(phraseWait('SUIUSDT', 'direction_not_allowed', composite({ Sprime: -0.4 }), null)).toBe(
      'Miré SUI y esperé: me pediste que no abra shorts.',
    )
  })

  it('el enfriamiento global se distingue del de la moneda', () => {
    expect(phraseWait('SUIUSDT', 'global_cooldown', composite())).toBe(
      'Miré SUI y esperé: saltaron varios stops en la última hora y dejo pasar unas velas antes de abrir.',
    )
    expect(phraseWait('SUIUSDT', 'cooldown', composite())).toBe('Miré SUI y esperé: dejo pasar unas velas después de una pérdida.')
  })

  it('cada motivo de bloqueo tiene frase propia y todas terminan en punto', () => {
    const reasons = [
      'has_position', 'cooldown', 'global_cooldown', 'penalty', 'degraded', 'max_positions', 'max_margin', 'max_notional',
      'insufficient_capital', 'daily_loss', 'drawdown_pause', 'streak_pause', 'paused', 'below_min_notional',
      'stop_too_small_for_cost', 'liquidation_too_close', 'risk_rounding', 'direction_not_allowed', 'no_candle',
    ] as const
    const phrases = new Set(reasons.map((r) => phraseWait('SUIUSDT', r, composite())))
    expect(phrases.size).toBe(reasons.length)
    for (const phrase of phrases) expect(phrase).toMatch(/^Miré SUI y esperé: .+\.$/)
  })
})

describe('phraseShield y phraseAccountRule', () => {
  it('blindaje sin cierres y con cierres', () => {
    expect(phraseShield({ capitalInicial: 1000, baseBlindaje: 1000, ganancia: 712.4, closedCount: 0 })).toBe(
      'Blindé los US$ 1.000 iniciales: de acá en más opero sólo con la ganancia (US$ 712,40).',
    )
    expect(phraseShield({ capitalInicial: 1000, baseBlindaje: 1000, ganancia: 712.4, closedCount: 2 })).toBe(
      'Blindé los US$ 1.000 iniciales: de acá en más opero sólo con la ganancia (US$ 712,40). Cerré 2 posiciones para que entren en lo ganado.',
    )
    expect(phraseShield({ capitalInicial: 1000, baseBlindaje: 1000, ganancia: 712.4, closedCount: 1 })).toContain('Cerré 1 posición para que entre en lo ganado.')
  })

  it('después de volver a usar el capital blindado, la base ya no es la inicial', () => {
    expect(phraseShield({ capitalInicial: 1000, baseBlindaje: 1312, ganancia: 920, closedCount: 0 })).toBe(
      'Blindé US$ 1.312: de acá en más opero sólo con la ganancia (US$ 920).',
    )
  })

  it('cortes a nivel cuenta', () => {
    expect(phraseAccountRule('daily_loss', { todayRealized: -31.2, limitPct: 0.03 })).toBe(
      'Perdí US$ 31,20 hoy y llegué al límite del 3% diario: no abro nada hasta mañana.',
    )
    expect(phraseAccountRule('daily_loss', { todayRealized: -25.4, limitPct: 0.025 })).toBe(
      'Perdí US$ 25,40 hoy y llegué al límite del 2,5% diario: no abro nada hasta mañana.',
    )
    expect(phraseAccountRule('drawdown', { peak: 1180, equity: 1003 })).toBe(
      'Me pausé solo: el capital cayó un 15,0% desde el pico (de US$ 1.180 a US$ 1.003). Lo reanudás vos cuando quieras.',
    )
    expect(phraseAccountRule('drawdown', { peak: 1180.5, equity: 1003.4 })).toBe(
      'Me pausé solo: el capital cayó un 15,0% desde el pico (de US$ 1.180,50 a US$ 1.003,40). Lo reanudás vos cuando quieras.',
    )
    expect(phraseAccountRule('drawdown', { peak: 0, equity: -12 })).toBe(
      'Me pausé solo: el capital cayó desde el pico (de US$ 0 a −US$ 12). Lo reanudás vos cuando quieras.',
    )
    expect(phraseAccountRule('streak', { stops: 6, until: Date.UTC(2026, 9, 14, 21, 32) })).toBe(
      '6 stops seguidos: no abro nada hasta las 18:32.',
    )
    expect(phraseAccountRule('shield', { capitalInicial: 1000, baseBlindaje: 1000, ganancia: 712.4, closedCount: 0 })).toBe(
      phraseShield({ capitalInicial: 1000, baseBlindaje: 1000, ganancia: 712.4, closedCount: 0 }),
    )
    expect(phraseAccountRule('shield_insufficient', { baseBlindaje: 1000 })).toBe(
      'Me pausé solo: los US$ 1.000 están blindados y no queda ganancia para operar.',
    )
  })

  it('drawdown de la sombra: no se pausa, lo dice y sigue', () => {
    expect(phraseShadowDrawdown({ peak: 1180, equity: 1003 })).toBe(
      'La sombra cayó un 15,0% desde su pico (de US$ 1.180 a US$ 1.003). No la pauso: sigue operando para que la comparación con lo aprendido no se corte.',
    )
    expect(phraseShadowDrawdown({ peak: 0, equity: -12 })).toBe(
      'La sombra cayó desde su pico (de US$ 0 a −US$ 12). No la pauso: sigue operando para que la comparación con lo aprendido no se corte.',
    )
  })
})
