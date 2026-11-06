import type { z } from 'zod'
import type { SettingsPatch } from '@sereno/db'
import { SettingsSchema, type Settings } from '@sereno/shared'
import { formatValue, type Unit } from './units'

// Validación en el cliente con el mismo esquema que aplica el servidor (y el bot):
// lo que no pasa no se manda, y el motivo se muestra junto al campo, en castellano
// y en la unidad del campo ("Como máximo 20x.", no "expected number to be <=20").

type Issue = z.core.$ZodIssue

function issueMessage(issue: Issue, unit: Unit): string {
  switch (issue.code) {
    case 'too_big':
      return `Como máximo ${formatValue(Number(issue.maximum), unit)}.`
    case 'too_small': {
      const bound = formatValue(Number(issue.minimum), unit)
      return issue.inclusive ? `Como mínimo ${bound}.` : `Tiene que ser mayor que ${bound}.`
    }
    case 'invalid_type':
      return issue.expected === 'int' ? 'Tiene que ser un número entero.' : 'Escribí un número.'
    default:
      return 'Ese valor no es válido: revisalo.'
  }
}

/**
 * Valida la configuración que quedaría con `patch` encima. Devuelve el mensaje para
 * el campo, o null si se puede guardar. La configuración vigente ya es válida, así que
 * lo que falle es lo que cambió.
 */
export function validatePatch(config: Settings, patch: SettingsPatch, unit: Unit): string | null {
  const result = SettingsSchema.safeParse({ ...config, ...patch })
  if (result.success) return null
  const [issue] = result.error.issues
  return issue ? issueMessage(issue, unit) : null
}
