// La lista blanca vive en `ALLOWED_EMAILS` (emails separados por coma) y se lee en
// cada chequeo: cambiar la lista no requiere tocar la base (spec §11.7).

/** Código de rechazo de Better Auth que la pantalla de acceso reconoce en `?error=`. */
export const NOT_ALLOWED = 'not_allowed'

function normalize(email: string): string {
  return email.trim().toLowerCase()
}

export function parseAllowedEmails(raw: string): ReadonlySet<string> {
  return new Set(raw.split(',').map(normalize).filter((email) => email.length > 0))
}

export function isAllowed(email: string | null | undefined, allowedEmails: string): boolean {
  if (!email) return false
  return parseAllowedEmails(allowedEmails).has(normalize(email))
}
