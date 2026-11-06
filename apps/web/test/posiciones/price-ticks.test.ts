import { describe, expect, it } from 'vitest'
import { priceTickLabels } from '@/components/charts/price-ticks'

// El eje de precios del gráfico: todas las marcas con los mismos decimales, los justos
// para su paso. Un eje de BTC no dice "75.000,00".

describe('marcas del eje de precios', () => {
  it('pasos redondos, sin decimales', () => {
    expect(priceTickLabels([75_000, 75_500, 76_000])).toEqual(['75.000', '75.500', '76.000'])
    expect(priceTickLabels([2_640, 2_650, 2_660])).toEqual(['2.640', '2.650', '2.660'])
  })

  it('un paso de 2,5 pide un decimal en todas las marcas', () => {
    expect(priceTickLabels([2_650, 2_652.5, 2_655])).toEqual(['2.650,0', '2.652,5', '2.655,0'])
  })

  it('precios chicos con los decimales de su paso, aunque lleguen con ruido de coma flotante', () => {
    expect(priceTickLabels([1.2, 1.4000000000000001, 1.6])).toEqual(['1,2', '1,4', '1,6'])
    expect(priceTickLabels([0.0000116, 0.0000118, 0.000012])).toEqual(['0,0000116', '0,0000118', '0,0000120'])
  })

  it('con una sola marca no hay paso: va el formato de precio de siempre', () => {
    expect(priceTickLabels([142.1])).toEqual(['142,10'])
  })
})
