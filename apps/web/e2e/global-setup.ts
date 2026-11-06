import { migrate } from '@sereno/db/migrate'
import { e2eEnv } from './env'
import { seedUser } from './seed'

// Una vez por corrida: las tablas al día y el usuario del dashboard. El escenario se
// vuelve a sembrar al empezar cada proyecto (ver `fixtures.ts`).
export default async function globalSetup(): Promise<void> {
  const { databaseUrl } = e2eEnv()
  await migrate(databaseUrl)
  seedUser(databaseUrl)
}
