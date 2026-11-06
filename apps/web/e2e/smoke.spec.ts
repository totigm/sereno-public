import { coinName } from '@sereno/core/src/journal/coin-name'
import { normalizeText, parseAmount, parseSignedAmount } from './amounts'
import { capture, deviceOf, SCHEMES, showScheme } from './capture'
import { pauseOf } from './db'
import { expect, login, test } from './fixtures'

// La prueba de humo de Task 32: entrar, recorrer las cinco pestañas, abrir las hojas de
// un trade y de una moneda, y pausar el bot, contra `pnpm dev` y la base sembrada con el
// escenario `active`. En cada pantalla, la consola del navegador queda sin errores ni avisos.

const SCREENS = [
  { tab: 'Resumen', path: '/', name: 'resumen', heading: /^Vas ganando US\$\s[\d.]+,\d{2} desde/ },
  { tab: 'Posiciones', path: '/posiciones', name: 'posiciones', heading: /^3 abiertas, van (ganando|perdiendo) US\$\s[\d.]+,\d{2}\.$/ },
  { tab: 'Monedas', path: '/monedas', name: 'monedas', heading: /^Mirando 30 monedas, con 3 posiciones abiertas\.$/ },
  { tab: 'Aprendizaje', path: '/aprendizaje', name: 'aprendizaje', heading: /^Estoy juntando datos: 23 de 50 trades cerrados\.$/ },
  { tab: 'Ajustes', path: '/ajustes', name: 'ajustes', heading: /^Ajustes$/ },
] as const

test('entra con la contraseña y el Resumen dice "Vas ganando"', async ({ page, consoleWatch }) => {
  await login(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SCREENS[0].heading)
  expect(consoleWatch.take()).toEqual([])
})

for (const screen of SCREENS) {
  test(`la pestaña ${screen.tab} se ve en claro y en oscuro sin errores en la consola`, async ({ page, consoleWatch }, info) => {
    await login(page)
    const nav = page.getByRole('navigation', { name: 'Secciones' })
    await nav.getByRole('link', { name: screen.tab }).click()
    await expect(page).toHaveURL(screen.path)
    await expect(nav.getByRole('link', { name: screen.tab })).toHaveAttribute('aria-current', 'page')
    for (const scheme of SCHEMES) {
      await showScheme(page, scheme)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.heading)
      await capture(page, info, screen.name, scheme, { fullPage: true })
      // La página completa va sin la barra inferior: una primera pantalla la muestra.
      if (screen.name === 'resumen' && deviceOf(info) === 'celular') {
        await capture(page, info, 'resumen-primera-pantalla', scheme, { fullPage: false })
      }
      expect(consoleWatch.take(), `${screen.tab} en ${scheme}`).toEqual([])
    }
  })
}

test('Resumen: titular con altura de línea 1,2 y, en escritorio, abiertas y capital a 1,3fr / 1fr', async ({ page, consoleWatch }, info) => {
  await login(page)
  const headline = page.getByRole('heading', { level: 1 })
  const type = await headline.evaluate((el) => {
    const style = getComputedStyle(el)
    return { fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) }
  })
  expect(type.lineHeight / type.fontSize).toBeCloseTo(1.2, 2)

  if (info.project.name.startsWith('escritorio')) {
    const open = await page.getByRole('region', { name: 'Abiertas ahora' }).boundingBox()
    const capital = await page.getByRole('region', { name: 'Tu capital' }).boundingBox()
    if (!open || !capital) throw new Error('No encuentro "Abiertas ahora" o "Tu capital".')
    expect(open.y).toBe(capital.y)
    expect(open.width / capital.width).toBeCloseTo(1.3, 2)
  }
  expect(consoleWatch.take()).toEqual([])
})

test('Resumen y Posiciones cuentan lo mismo: lo abierto suma sus filas y lo cerrado es el de Posiciones', async ({ page, consoleWatch }) => {
  await login(page)
  const secondary = normalizeText(await page.locator('p').filter({ hasText: /^Cerrado\s/ }).textContent())
  const parts = /^Cerrado (\S+) · abierto (\S+) ·/.exec(secondary)
  if (!parts?.[1] || !parts[2]) throw new Error(`La línea secundaria no tiene cerrado y abierto: "${secondary}".`)
  const closed = parseAmount(parts[1])
  const open = parseAmount(parts[2])

  // Cada fila redondea su resultado a centavos: la suma puede correrse hasta 1,5 centavos.
  const rows = await page.getByRole('list', { name: 'Abiertas ahora' }).getByRole('link').allTextContents()
  expect(rows).toHaveLength(3)
  const rowsTotal = rows.reduce((sum, row) => sum + parseSignedAmount(normalizeText(row)), 0)
  expect(Math.abs(rowsTotal - open)).toBeLessThanOrEqual(0.015 + 1e-9)

  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Posiciones' }).click()
  await expect(page).toHaveURL('/posiciones')
  // "3 abiertas, van ganando US$ 0,04." y "23 cerradas, 14 ganadas · cerrado +US$ 58,59".
  const heading = normalizeText(await page.getByRole('heading', { level: 1 }).textContent())
  expect((heading.includes('perdiendo') ? -1 : 1) * parseAmount(heading)).toBe(open)
  const closedLine = normalizeText(await page.locator('p').filter({ hasText: / · cerrado / }).textContent())
  expect(parseAmount(closedLine.slice(closedLine.indexOf(' · cerrado ')))).toBe(closed)
  expect(consoleWatch.take()).toEqual([])
})

test('las hojas de un trade y de una moneda se abren desde la URL', async ({ page, consoleWatch, bot }, info) => {
  await login(page)
  const sheets = [
    { name: 'hoja-trade', url: `/?trade=${encodeURIComponent(bot.trade.id)}` },
    { name: 'hoja-moneda', url: `/monedas?moneda=${encodeURIComponent(bot.trade.symbol)}` },
  ]
  for (const sheet of sheets) {
    await page.goto(sheet.url)
    for (const scheme of SCHEMES) {
      await showScheme(page, scheme)
      // La hoja es la del trade o la moneda de la URL, no cualquiera.
      await expect(page.getByRole('dialog', { name: new RegExp(`^${coinName(bot.trade.symbol)}\\b`) })).toBeVisible()
      await capture(page, info, sheet.name, scheme, { fullPage: false })
      expect(consoleWatch.take(), `${sheet.name} en ${scheme}`).toEqual([])
    }
  }
})

test('sin conexión, la banda llega del servidor ya a la vista y hidrata sin avisos', async ({ page, consoleWatch, bot }) => {
  await login(page)
  await bot.disconnect()
  try {
    await page.reload()
    await expect(page.getByRole('status').filter({ hasText: /^Bot sin conexión desde/ })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeDisabled()
    expect(consoleWatch.take()).toEqual([])
  } finally {
    await bot.reconnect()
  }
})

test('"Pausar" deja la pausa en la base y "Reanudar" la saca', async ({ page, consoleWatch, bot }) => {
  await login(page)
  await page.getByRole('button', { name: 'Pausar', exact: true }).click()
  // Con abiertas, una hoja pregunta qué hacer con ellas.
  await page.getByRole('dialog').getByRole('button', { name: /^Pausar \(sigo cuidando las \d+ abiertas\)$/ }).click()
  await expect.poll(() => pauseOf(bot.db, bot.sessionId)).toMatchObject({ paused: true, by: 'user' })
  await expect(page.getByRole('button', { name: 'Reanudar', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Reanudar', exact: true }).click()
  await expect.poll(() => pauseOf(bot.db, bot.sessionId)).toMatchObject({ paused: false, by: null })
  await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible()
  expect(consoleWatch.take()).toEqual([])
})
