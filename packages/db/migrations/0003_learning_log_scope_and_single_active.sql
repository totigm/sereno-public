-- `learning_log` guarda a qué moneda y a qué señal se acota cada cambio (los
-- campos `symbol` y `signal` de `LearningChange` en core).
-- El bot opera una sola simulación a la vez: a lo sumo una sesión `active`.
ALTER TABLE "learning_log" ADD COLUMN "symbol" text;--> statement-breakpoint
ALTER TABLE "learning_log" ADD COLUMN "signal" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_single_active_idx" ON "sessions" USING btree ("status") WHERE "sessions"."status" = 'active';