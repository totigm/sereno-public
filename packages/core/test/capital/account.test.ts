import { describe, expect, it } from 'vitest'
import type { Position } from '../../src/types'
import { Account, type AccountInit } from '../../src/capital/account'

// Posición mínima y determinista: long por defecto, entrada 100, qty 1, riesgoReal 10
// (⇒ 1 R = US$ 10 de resultado). Se sobreescribe sólo lo que cada caso necesita.
function position(overrides: Partial<Position> & { id: string }): Position {
  return {
    symbol: `${overrides.id}USDT`,
    side: 'long',
    leverage: 5,
    margin: 20,
    notional: 100,
    qty: 1,
    entryPrice: 100,
    openedAt: 0,
    stopPrice: 90,
    takeProfitPrice: null,
    liquidationPrice: 80,
    distanciaStop: 10,
    riesgoReal: 10,
    thetaAtOpen: 0.4,
    trailingActive: false,
    bestPrice: 100,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0,
    fundingPaid: 0,
    shadow: false,
    openReason: 'test',
    signalsAtOpen: [],
    mode: 'auto',
    ...overrides,
  }
}

function account(overrides: Partial<AccountInit> = {}): Account {
  return new Account({ capitalInicial: 100, reinvest: true, protectPct: 0.7, onShield: 'reduce', ...overrides })
}

describe('Account › blindaje', () => {
  it('(a) dispara con I₀ 100, p 0,7, realizado +70 y sin abiertas: protegido 100, capitalBase 70', () => {
    const acc = account()
    acc.applyRealized(70)

    const result = acc.checkShield([], {})
    expect(result.triggered).toBe(true)
    expect(result.toClose).toEqual([])

    const snap = acc.snapshot([], {})
    expect(snap.saldo).toBe(170)
    expect(snap.protegido).toBe(100)
    expect(snap.baseBlindaje).toBe(100)
    expect(snap.capitalBase).toBe(70)
    expect(snap.capitalOperable).toBe(70)
  })

  it('(b) no dispara si equity − base < umbral: realizado +70 pero abiertas con −60 no realizado', () => {
    const acc = account()
    acc.applyRealized(70)
    const open = [position({ id: 'A', entryPrice: 100, qty: 1 })]
    const marks = { AUSDT: 40 } // (40 − 100) × 1 = −60

    const result = acc.checkShield(open, marks)
    expect(result.triggered).toBe(false)
    expect(result.toClose).toEqual([])

    const snap = acc.snapshot(open, marks)
    expect(snap.unrealized).toBe(-60)
    expect(snap.equity).toBe(110)
    expect(snap.protegido).toBe(0)
  })

  it('(c) reduce: realizado +70 y 5 abiertas con margen 20 (100 > 70) ⇒ cierra las 2 de peor R, en orden', () => {
    const acc = account({ onShield: 'reduce' })
    acc.applyRealized(70)
    const open = [
      position({ id: 'A' }), // R −0,5
      position({ id: 'B' }), // R −1
      position({ id: 'C' }), // R +0,3
      position({ id: 'D' }), // R +2
      position({ id: 'E' }), // R +0,1
    ]
    // No realizado total: −5 −10 +3 +20 +1 = +9 ⇒ equity − base = 79; min(70, 79) = 70 ≥ 70.
    const marks = { AUSDT: 95, BUSDT: 90, CUSDT: 103, DUSDT: 120, EUSDT: 101 }

    const result = acc.checkShield(open, marks)
    expect(result.triggered).toBe(true)
    expect(result.toClose.map((p) => p.id)).toEqual(['B', 'A'])
    expect(acc.snapshot(open, marks).protegido).toBe(100)
  })

  it('reduce no cierra nada cuando los márgenes ya entran en saldo − baseBlindaje', () => {
    const acc = account({ onShield: 'reduce' })
    acc.applyRealized(70)
    const open = [position({ id: 'A', margin: 30 }), position({ id: 'B', margin: 30 })]
    const marks = { AUSDT: 100, BUSDT: 100 }

    const result = acc.checkShield(open, marks)
    expect(result.triggered).toBe(true)
    expect(result.toClose).toEqual([])
  })

  it("'closeAll' devuelve todas las abiertas y 'keep' ninguna", () => {
    const open = [position({ id: 'A' }), position({ id: 'B' })]
    const marks = { AUSDT: 100, BUSDT: 100 }

    const closeAll = account({ onShield: 'closeAll' })
    closeAll.applyRealized(70)
    expect(closeAll.checkShield(open, marks).toClose.map((p) => p.id)).toEqual(['A', 'B'])

    const keep = account({ onShield: 'keep' })
    keep.applyRealized(70)
    const result = keep.checkShield(open, marks)
    expect(result.triggered).toBe(true)
    expect(result.toClose).toEqual([])
  })

  it('una vez blindado no vuelve a disparar aunque la ganancia siga creciendo', () => {
    const acc = account()
    acc.applyRealized(70)
    expect(acc.checkShield([], {}).triggered).toBe(true)
    acc.applyRealized(500)
    expect(acc.checkShield([], {}).triggered).toBe(false)
    expect(acc.snapshot([], {}).protegido).toBe(100)
  })

  it('con protectPct 0 el blindaje está apagado', () => {
    const acc = account({ protectPct: 0 })
    acc.applyRealized(1000)
    expect(acc.checkShield([], {}).triggered).toBe(false)
    expect(acc.snapshot([], {}).protegido).toBe(0)
  })

  it('(e) volver a usar: saldo 150 blindado 100 ⇒ protegido 0, baseBlindaje 150 y el disparo pide +105 desde ahí', () => {
    const acc = account()
    acc.applyRealized(70)
    expect(acc.checkShield([], {}).triggered).toBe(true)
    acc.applyRealized(-20) // saldo 150, protegido 100

    expect(acc.releaseProtected()).toEqual({ released: true })
    let snap = acc.snapshot([], {})
    expect(snap.protegido).toBe(0)
    expect(snap.baseBlindaje).toBe(150)
    expect(snap.capitalBase).toBe(150)

    acc.applyRealized(104)
    expect(acc.checkShield([], {}).triggered).toBe(false)
    acc.applyRealized(1) // +105 desde la base de 150 = 0,7 × 150
    expect(acc.checkShield([], {}).triggered).toBe(true)

    snap = acc.snapshot([], {})
    expect(snap.protegido).toBe(150)
    expect(snap.baseBlindaje).toBe(150)
    expect(snap.saldo).toBe(255)
    expect(snap.capitalBase).toBe(105)
    // El titular y el ROI siguen midiendo contra I₀.
    expect(snap.capitalInicial).toBe(100)
    expect(snap.realizado).toBe(155)
  })
})

describe('Account › blindaje en los bordes', () => {
  it('un residuo de coma flotante por debajo del umbral igual dispara (misma tolerancia que el riesgo)', () => {
    const acc = account()
    for (let i = 0; i < 7; i++) acc.applyRealized(10.1)
    acc.applyRealized(-0.7) // realizado 69,99999999999997
    expect(acc.snapshot([], {}).realizado).toBeLessThan(70)
    expect(acc.checkShield([], {}).triggered).toBe(true)
  })

  it('reduce con no realizado negativo: el colchón es saldo − base, no equity − base', () => {
    const acc = account({ onShield: 'reduce' })
    acc.applyRealized(80) // saldo 180
    const open = ['A', 'B', 'C', 'D'].map((id) => position({ id, margin: 20 }))
    // No realizado −5 ⇒ equity − base = 75; min(80, 75) = 75 ≥ 70 ⇒ dispara.
    const marks = { AUSDT: 95, BUSDT: 100, CUSDT: 100, DUSDT: 100 }
    const result = acc.checkShield(open, marks)
    expect(result.triggered).toBe(true)
    // Márgenes 80 ≤ saldo − base = 80: no cierra nada (con equity − base = 75 cerraría una).
    expect(result.toClose).toEqual([])
  })

  it('reduce ordena por R neto: descuenta comisiones y funding pagados', () => {
    const acc = account({ onShield: 'reduce' })
    acc.applyRealized(70)
    const open = [
      position({ id: 'A' }), // bruto −5 ⇒ R −0,5
      position({ id: 'B', feesPaid: 2.5, fundingPaid: 1.5 }), // bruto −3 − 4 ⇒ R neto −0,7
      position({ id: 'C' }),
      position({ id: 'D' }),
    ]
    // No realizado bruto −5 −3 +10 +10 = +12; márgenes 80 > 70 ⇒ cierra una sola.
    const marks = { AUSDT: 95, BUSDT: 97, CUSDT: 110, DUSDT: 110 }
    const result = acc.checkShield(open, marks)
    expect(result.triggered).toBe(true)
    expect(result.toClose.map((p) => p.id)).toEqual(['B'])
  })
})

describe('Account › marca faltante', () => {
  it('checkShield no evalúa el blindaje si a una abierta le falta la marca', () => {
    const acc = account()
    acc.applyRealized(70)
    // Con la marca a 100 dispararía; sin la marca de B no se sabe si B pierde.
    const open = [position({ id: 'A' }), position({ id: 'B' })]
    const result = acc.checkShield(open, { AUSDT: 100 })
    expect(result).toEqual({ triggered: false, toClose: [], skipped: { reason: 'missing_mark', symbols: ['BUSDT'] } })
    expect(acc.snapshot([], {}).protegido).toBe(0)
    // En el ciclo siguiente, con todas las marcas, se evalúa normalmente.
    expect(acc.checkShield(open, { AUSDT: 100, BUSDT: 100 }).triggered).toBe(true)
  })

  it('una marca no finita o no positiva cuenta como faltante', () => {
    const acc = account()
    acc.applyRealized(70)
    const open = [position({ id: 'A' }), position({ id: 'B' }), position({ id: 'C' })]
    const result = acc.checkShield(open, { AUSDT: Number.NaN, BUSDT: 0, CUSDT: 100 })
    expect(result.skipped).toEqual({ reason: 'missing_mark', symbols: ['AUSDT', 'BUSDT'] })
    expect(acc.snapshot([], {}).protegido).toBe(0)
  })

  it('el snapshot marca marksIncomplete y no inventa no realizado para la que falta', () => {
    const acc = account()
    const open = [position({ id: 'A' }), position({ id: 'B' })]
    const snap = acc.snapshot(open, { AUSDT: 110 })
    expect(snap.marksIncomplete).toBe(true)
    expect(snap.unrealized).toBe(10)
    expect(snap.equity).toBe(110)
  })

  it('con todas las marcas el snapshot no lleva marksIncomplete', () => {
    const acc = account()
    const open = [position({ id: 'A' })]
    expect(acc.snapshot(open, { AUSDT: 110 })).not.toHaveProperty('marksIncomplete')
    expect(acc.snapshot([], {})).not.toHaveProperty('marksIncomplete')
  })
})

describe('Account › volver a usar el capital blindado', () => {
  it('sin blindaje activo no cambia nada y lo dice', () => {
    const acc = account()
    acc.applyRealized(-30) // saldo 70: re-basar bajaría el umbral del disparo
    expect(acc.releaseProtected()).toEqual({ released: false, reason: 'not_shielded' })
    const snap = acc.snapshot([], {})
    expect(snap.baseBlindaje).toBe(100)
    expect(snap.protegido).toBe(0)
  })

  it('con saldo ≤ 0 no libera: protegido y base quedan como estaban', () => {
    const acc = account({ reinvest: true })
    acc.applyRealized(70)
    expect(acc.checkShield([], {}).triggered).toBe(true)
    acc.applyRealized(-170) // saldo 0
    expect(acc.releaseProtected()).toEqual({ released: false, reason: 'no_balance' })
    const snap = acc.snapshot([], {})
    expect(snap.protegido).toBe(100)
    expect(snap.baseBlindaje).toBe(100)
  })
})

describe('Account › reinversión y capital', () => {
  it('capitalBase nunca es negativo: pérdida posterior al blindaje con reinversión', () => {
    const acc = account({ reinvest: true })
    acc.applyRealized(70) // saldo 170
    expect(acc.checkShield([], {}).triggered).toBe(true)
    acc.applyRealized(-90) // saldo 80 < protegido 100
    const snap = acc.snapshot([], {})
    expect(snap.saldo).toBe(80)
    expect(snap.protegido).toBe(100)
    expect(snap.capitalBase).toBe(0)
    expect(snap.capitalOperable).toBe(0)
    // El equity y el realizado siguen mostrando la verdad: no se recorta lo que pasó.
    expect(snap.equity).toBe(80)
    expect(snap.realizado).toBe(-20)
  })

  it('capitalBase nunca es negativo con reinversión apagada', () => {
    const acc = account({ reinvest: false })
    acc.applyRealized(70)
    acc.checkShield([], {})
    acc.applyRealized(-90)
    expect(acc.snapshot([], {}).capitalBase).toBe(0)
  })

  it('(d) reinvest apagada: saldo 1.300, base 1.000 ⇒ capitalBase 1000', () => {
    const acc = account({ capitalInicial: 1000, reinvest: false })
    acc.applyRealized(300)
    expect(acc.snapshot([], {}).capitalBase).toBe(1000)
    expect(acc.snapshot([], {}).reinvest).toBe(false)
  })

  it('reinvest encendida: la base es el saldo completo (interés compuesto)', () => {
    const acc = account({ capitalInicial: 1000, reinvest: true })
    acc.applyRealized(300)
    expect(acc.snapshot([], {}).capitalBase).toBe(1300)
  })

  it('setReinvest cambia la base en caliente', () => {
    const acc = account({ capitalInicial: 1000, reinvest: true })
    acc.applyRealized(300)
    acc.setReinvest(false)
    expect(acc.snapshot([], {}).capitalBase).toBe(1000)
    acc.setReinvest(true)
    expect(acc.snapshot([], {}).capitalBase).toBe(1300)
  })

  it('reinvest apagada con pérdidas: la base es el saldo (no se opera con capital que no hay)', () => {
    const acc = account({ capitalInicial: 1000, reinvest: false })
    acc.applyRealized(-200)
    expect(acc.snapshot([], {}).capitalBase).toBe(800)
  })

  it('con capital blindado y reinvest apagada la base es la ganancia disponible', () => {
    const acc = account({ capitalInicial: 1000, reinvest: false })
    acc.applyRealized(700)
    acc.checkShield([], {})
    expect(acc.snapshot([], {}).capitalBase).toBe(700)
  })

  it('(f) capitalOperable nunca es negativo', () => {
    const acc = account()
    const open = [position({ id: 'A', margin: 150 })]
    const snap = acc.snapshot(open, { AUSDT: 100 })
    expect(snap.margenEnUso).toBe(150)
    expect(snap.capitalBase).toBe(100)
    expect(snap.capitalOperable).toBe(0)
  })

  it('capitalOperable descuenta el margen en uso', () => {
    const acc = account()
    const open = [position({ id: 'A', margin: 20 }), position({ id: 'B', margin: 15 })]
    expect(acc.marginInUse(open)).toBe(35)
    expect(acc.snapshot(open, { AUSDT: 100, BUSDT: 100 }).capitalOperable).toBe(65)
  })
})

describe('Account › snapshot y resultados', () => {
  it('el no realizado de una short se invierte y el equity lo incluye', () => {
    const acc = account()
    const open = [
      position({ id: 'L', side: 'long', entryPrice: 100, qty: 2 }), // (110 − 100) × 2 = +20
      position({ id: 'S', side: 'short', entryPrice: 100, qty: 3 }), // (90 − 100) × 3 × −1 = +30
    ]
    const snap = acc.snapshot(open, { LUSDT: 110, SUSDT: 90 })
    expect(snap.unrealized).toBe(50)
    expect(snap.equity).toBe(150)
    expect(snap.saldo).toBe(100)
    expect(snap.realizado).toBe(0)
  })

  it('applyRealized acumula ganancias, pérdidas, comisiones y funding en el saldo', () => {
    const acc = account()
    acc.applyRealized(25)
    acc.applyRealized(-10.5)
    acc.applyRealized(-0.25)
    const snap = acc.snapshot([], {})
    expect(snap.saldo).toBeCloseTo(114.25)
    expect(snap.realizado).toBeCloseTo(14.25)
  })

  it('applyRealized rechaza montos no finitos', () => {
    const acc = account()
    expect(() => acc.applyRealized(Number.NaN)).toThrow()
    expect(() => acc.applyRealized(Number.POSITIVE_INFINITY)).toThrow()
    expect(acc.snapshot([], {}).saldo).toBe(100)
  })

  it('se puede restaurar desde un estado persistido', () => {
    const acc = account({ saldo: 250, protegido: 100, baseBlindaje: 100 })
    const snap = acc.snapshot([], {})
    expect(snap.saldo).toBe(250)
    expect(snap.protegido).toBe(100)
    expect(snap.baseBlindaje).toBe(100)
    expect(snap.capitalBase).toBe(150)
    expect(acc.checkShield([], {}).triggered).toBe(false)
  })

  it('rechaza un estado restaurado inválido igual que un capital inicial inválido', () => {
    expect(() => account({ saldo: Number.NaN })).toThrow(RangeError)
    expect(() => account({ saldo: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => account({ protegido: Number.NaN })).toThrow(RangeError)
    expect(() => account({ protegido: -1 })).toThrow(RangeError)
    expect(() => account({ baseBlindaje: Number.NaN })).toThrow(RangeError)
    expect(() => account({ baseBlindaje: 0 })).toThrow(RangeError)
    expect(() => account({ baseBlindaje: -100 })).toThrow(RangeError)
  })

  it('acepta un estado restaurado con saldo en pérdida o en cero', () => {
    expect(account({ saldo: -5, protegido: 0, baseBlindaje: 100 }).snapshot([], {}).saldo).toBe(-5)
    expect(account({ saldo: 0 }).snapshot([], {}).capitalBase).toBe(0)
  })

  it('rechaza un capital inicial no positivo y un protectPct fuera de [0, 1]', () => {
    expect(() => account({ capitalInicial: 0 })).toThrow()
    expect(() => account({ capitalInicial: -5 })).toThrow()
    expect(() => account({ protectPct: 1.5 })).toThrow()
    expect(() => account({ protectPct: -0.1 })).toThrow()
  })
})
