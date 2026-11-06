# Capturas de revisión

Las saca la prueba de humo (`apps/web/e2e/smoke.spec.ts`) contra `pnpm dev` y la base de
desarrollo sembrada con el escenario `active` (US$ 1.000 desde hace 16 días, 23 cerradas con
14 ganadas, 3 abiertas: ETH long 2x, AVAX short 3x, SOL long 5x; WIF en penitencia, NEAR en
enfriamiento, FIL sin datos). Celular 375×812 a 2x y escritorio 1280×800 a 1x, con movimiento.
Las pantallas van a página completa (en el celular, sin la barra inferior fija, que en la
página completa quedaría pintada encima del contenido); las hojas, sólo lo que se ve.

Para regenerarlas: `E2E_REVIEW=1 pnpm e2e` (y `oxipng -o 4 --strip safe` sobre la carpeta).
La prueba vuelve a sembrar la base, así que `DATABASE_URL` (del entorno o de
`apps/web/.env.local`) tiene que apuntar a una base de desarrollo cuyo nombre termine en
`_dev` o `_test`: contra `sereno` o Neon se niega a correr. En el checkout principal,
`.env.local` apunta a `sereno`: corré con `DATABASE_URL=postgresql://…/sereno_dev pnpm e2e`.
Sin `E2E_REVIEW`, la prueba deja sus capturas en `.local/shots/e2e/<proyecto>/`, que no se
commitea. El email con que se entra (Ajustes › Cuenta) sale tapado en todas.

## Resumen

- `resumen-celular-claro.png`: titular "Vas ganando US$ …" con el número en verde, línea secundaria, veredicto, curva de 7 días, abiertas, Tu capital, Lo último que hizo y Estado del bot con "Pausar".
- `resumen-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `resumen-primera-pantalla-celular-claro.png`: sólo lo que se ve al abrir, con la barra inferior (material translúcido, ícono y etiqueta de 11 px, Resumen activa).
- `resumen-primera-pantalla-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `resumen-escritorio-claro.png`: columna de 640 px; "Abiertas ahora" y "Tu capital" lado a lado a 1,3fr / 1fr; chip "En vivo" en la barra superior.
- `resumen-escritorio-oscuro.png`: lo mismo con los tokens oscuros.

## Posiciones

- `posiciones-celular-claro.png`: "3 abiertas, van ganando …", segmento Abiertas / Cerradas / Estadísticas y las tres tarjetas con la barra liq. · stop ─●─ TP.
- `posiciones-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `posiciones-escritorio-claro.png`: la tabla de abiertas con numerales tabulares y "Cerrar ahora" por fila.
- `posiciones-escritorio-oscuro.png`: lo mismo con los tokens oscuros.

## Monedas

- `monedas-celular-claro.png`: el tablero a 3 columnas; primero las abiertas (borde y fondo de ganancia o pérdida), WIF en penitencia, FIL sin datos, NEAR en espera.
- `monedas-celular-oscuro.png`: lo mismo con los fondos del mockup Tablero.
- `monedas-escritorio-claro.png`: el tablero a 6 columnas a todo el ancho.
- `monedas-escritorio-oscuro.png`: lo mismo con los tokens oscuros (comparar con `specs/assets/mockups/a-tablero.png`).

## Aprendizaje

- `aprendizaje-celular-claro.png`: "Estoy juntando datos: 23 de 50", qué cambió, originales contra aprendidos, señales, monedas, parámetros, controles y replays.
- `aprendizaje-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `aprendizaje-escritorio-claro.png`: la misma pantalla en la columna de escritorio.
- `aprendizaje-escritorio-oscuro.png`: lo mismo con los tokens oscuros.

## Ajustes

- `ajustes-celular-claro.png`: Capital con la frase viva del blindaje, Modo, Riesgo (avanzado) cerrado, Universo, Bot, Modo real y Cuenta.
- `ajustes-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `ajustes-escritorio-claro.png`: la misma pantalla en la columna de escritorio.
- `ajustes-escritorio-oscuro.png`: lo mismo con los tokens oscuros.

## Hoja de un trade (`/?trade=<id>`)

- `hoja-trade-celular-claro.png`: la hoja desde abajo con el asa: ETH Long 2x y su resultado, velas con entrada, stop (y de dónde arrancó), TP y precio, y "Cerrar ahora" fijo al pie.
- `hoja-trade-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `hoja-trade-escritorio-claro.png`: el panel centrado de 560 px sobre Resumen con el scrim.
- `hoja-trade-escritorio-oscuro.png`: lo mismo con los tokens oscuros; el velo oscurece la página (no la aclara).

## Hoja de una moneda (`/monedas?moneda=<símbolo>`)

- `hoja-moneda-celular-claro.png`: ETH con su abierta, el gráfico de 48 h, las señales del último ciclo y "Fijar" / "Excluir" al pie.
- `hoja-moneda-celular-oscuro.png`: lo mismo con los tokens oscuros.
- `hoja-moneda-escritorio-claro.png`: el panel centrado sobre el tablero.
- `hoja-moneda-escritorio-oscuro.png`: lo mismo con los tokens oscuros; el velo oscurece la página.
