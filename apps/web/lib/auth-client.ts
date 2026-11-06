import { createAuthClient } from 'better-auth/react'

// Sin `baseURL`: el cliente usa el mismo origen que sirve la página.
export const authClient = createAuthClient()
