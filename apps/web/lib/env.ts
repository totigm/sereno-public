import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'
import { parseAllowedEmails } from './allowlist'

const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const

// Variables del servidor (spec §13). Las mismas están en `turbo.json` `globalEnv` y en
// `.env.example`. No hay variables de cliente: el botón de Google se decide en el servidor.
export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32, 'Generalo con `openssl rand -base64 32`.'),
    BETTER_AUTH_URL: z.url(),
    ALLOWED_EMAILS: z
      .string()
      .refine((raw) => parseAllowedEmails(raw).size > 0, 'Hace falta al menos un email autorizado.'),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  },
  // Con una sola de las credenciales, Better Auth apagaría Google sin avisar: mejor no
  // arrancar con un entorno de Vercel a medio configurar.
  createFinalSchema: (shape) =>
    z.object(shape).superRefine((vars, ctx) => {
      const missing = GOOGLE_KEYS.filter((key) => vars[key] === undefined)
      if (missing.length !== 1) return
      ctx.addIssue({
        code: 'custom',
        path: missing,
        message: 'GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET van juntos: completá los dos para entrar con Google, o ninguno.',
      })
    }),
  experimental__runtimeEnv: {},
  // `GOOGLE_CLIENT_ID=` vacío en el .env cuenta como ausente, no como credencial.
  emptyStringAsUndefined: true,
})
