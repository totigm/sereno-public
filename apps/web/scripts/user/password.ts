import { randomBytes } from 'node:crypto'

// 24 bytes en base64url: 32 caracteres sin símbolos que haya que citar en un `.env`.
const PASSWORD_BYTES = 24

export function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url')
}
