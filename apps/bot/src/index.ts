// Punto de entrada del bot: `pnpm bot` corre el proceso en vivo (el comando por defecto);
// `pnpm bot replay --days 90` corre un replay por línea de comandos; `pnpm bot real-off`
// cierra lo del bot en Binance y apaga la operación con plata real.
import { runLive } from './live/main'
import { runRealOffCli } from './real/real-off'
import { runReplayCli } from './replay/cli'

const [command = 'live', ...args] = process.argv.slice(2)

if (command === 'live') {
  await runLive()
} else if (command === 'replay') {
  process.exitCode = await runReplayCli(args)
} else if (command === 'real-off') {
  process.exitCode = await runRealOffCli(args)
} else {
  console.error(`sereno · comando desconocido: ${command} (usá "live", "replay" o "real-off")`)
  process.exitCode = 1
}
