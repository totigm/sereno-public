CREATE TYPE "public"."real_status" AS ENUM('on', 'off', 'loss_floor');--> statement-breakpoint
ALTER TYPE "public"."bot_phase" ADD VALUE 'off';--> statement-breakpoint
ALTER TYPE "public"."command_kind" ADD VALUE 'real_off';--> statement-breakpoint
CREATE TABLE "real_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "real_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"symbol" text,
	"phrase" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "real_readiness" (
	"env" text PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"enabled" boolean NOT NULL,
	"keys_present" boolean NOT NULL,
	"checks" jsonb NOT NULL,
	"wallet_available" double precision,
	"instance_id" text NOT NULL
);
--> statement-breakpoint
DROP INDEX "sessions_single_active_idx";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "binance_env" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "real_status" real_status;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "real_off_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "real_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_status" ADD COLUMN "real" jsonb;--> statement-breakpoint
ALTER TABLE "real_events" ADD CONSTRAINT "real_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "real_events_session_id_at_idx" ON "real_events" USING btree ("session_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_single_active_per_kind_idx" ON "sessions" USING btree ("kind") WHERE "sessions"."status" = 'active';