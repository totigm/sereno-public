import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Los paquetes internos se consumen desde `src` (TypeScript sin compilar).
  transpilePackages: ['@sereno/shared', '@sereno/core', '@sereno/db'],
  // `next dev` genera un AGENTS.md propio; las reglas del repo viven en la raíz.
  agentRules: false,
  // La prueba de humo lee la consola del navegador por su cuenta (y falla con cualquier
  // aviso): que `next dev` no la repita en la terminal de la corrida.
  ...(process.env.SERENO_E2E === '1' ? { logging: { browserToTerminal: false } } : {}),
}

export default nextConfig
