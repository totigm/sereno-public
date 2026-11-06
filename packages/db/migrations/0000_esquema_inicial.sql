CREATE TYPE "public"."bot_phase" AS ENUM('starting', 'warming', 'live', 'paused', 'waiting_lease');--> statement-breakpoint
CREATE TYPE "public"."command_kind" AS ENUM('close_position', 'close_all', 'run_replay', 'cancel_replay', 'release_protected', 'reset_learning');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('pending', 'claimed', 'done', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."equity_snapshot_kind" AS ENUM('minute', 'event');--> statement-breakpoint
CREATE TYPE "public"."position_event_kind" AS ENUM('open', 'stop_moved', 'funding', 'partial_close', 'close', 'liquidation', 'order_placed', 'order_cancelled');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('paper_live', 'replay', 'live');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'archived', 'en_cola', 'descargando', 'simulando', 'listo', 'fallido', 'cancelado');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "session_kind" NOT NULL,
	"name" text NOT NULL,
	"status" "session_status" NOT NULL,
	"capital_inicial" double precision NOT NULL,
	"base_blindaje" double precision NOT NULL,
	"protegido" double precision DEFAULT 0 NOT NULL,
	"settings_snapshot" jsonb NOT NULL,
	"learning_origin" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"progreso" double precision,
	"mensaje" text,
	"replay_params" jsonb
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"session_id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "settings_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settings_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_history_session_id_version_key" UNIQUE("session_id","version")
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"symbol" text PRIMARY KEY NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"contract_type" text NOT NULL,
	"status" text NOT NULL,
	"min_notional" double precision NOT NULL,
	"min_qty" double precision NOT NULL,
	"step_size" double precision NOT NULL,
	"tick_size" double precision NOT NULL,
	"quantity_precision" integer NOT NULL,
	"underlying_type" text NOT NULL,
	"underlying_sub_type" text[] NOT NULL,
	"onboard_date" timestamp with time zone NOT NULL,
	"funding_interval_hours" integer NOT NULL,
	"liquidation_fee" double precision NOT NULL,
	"mmr" double precision NOT NULL,
	"observed_spread" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "universe_days" (
	"session_id" text NOT NULL,
	"day" date NOT NULL,
	"symbols" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "universe_days_session_id_day_pk" PRIMARY KEY("session_id","day")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"mode" text NOT NULL,
	"leverage" integer NOT NULL,
	"margin" double precision NOT NULL,
	"notional" double precision NOT NULL,
	"qty" double precision NOT NULL,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision,
	"stop_price" double precision NOT NULL,
	"take_profit_price" double precision,
	"liquidation_price" double precision NOT NULL,
	"trailing_active" boolean DEFAULT false NOT NULL,
	"best_price" double precision NOT NULL,
	"riesgo_real" double precision NOT NULL,
	"distancia_stop" double precision NOT NULL,
	"theta_at_open" double precision NOT NULL,
	"stop_order_id" text,
	"tp_order_id" text,
	"fees" double precision DEFAULT 0 NOT NULL,
	"funding" double precision DEFAULT 0 NOT NULL,
	"pnl_gross" double precision,
	"pnl_net" double precision,
	"r_multiple" double precision,
	"open_reason" text NOT NULL,
	"close_reason" text,
	"close_phrase" text,
	"signals_at_open" jsonb NOT NULL,
	"missing_signals" jsonb NOT NULL,
	"costs" jsonb,
	"latency_ms" integer,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"shadow" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"position_id" text NOT NULL,
	"kind" "position_event_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"symbol" text NOT NULL,
	"candle_close_time" timestamp with time zone NOT NULL,
	"s" double precision NOT NULL,
	"s_prime" double precision NOT NULL,
	"signals" jsonb NOT NULL,
	"missing_signals" jsonb NOT NULL,
	"action" text NOT NULL,
	"blocked_by" text,
	"forward_return_4h" double precision,
	"forward_return_24h" double precision,
	"shadow_action" text
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equity_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"saldo" double precision NOT NULL,
	"equity" double precision NOT NULL,
	"margen_en_uso" double precision NOT NULL,
	"protegido" double precision NOT NULL,
	"capital_base" double precision NOT NULL,
	"capital_operable" double precision NOT NULL,
	"shadow_equity" double precision,
	"kind" "equity_snapshot_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_snapshot" (
	"session_id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"symbols" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"price_type" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"quote_volume" double precision NOT NULL,
	"closed" boolean NOT NULL,
	CONSTRAINT "candles_symbol_timeframe_price_type_open_time_pk" PRIMARY KEY("symbol","timeframe","price_type","open_time")
);
--> statement-breakpoint
CREATE TABLE "futures_data" (
	"symbol" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"funding_rate" double precision,
	"next_funding_time" timestamp with time zone,
	"open_interest" double precision,
	"long_short_ratio" double precision,
	"taker_ratio" double precision,
	CONSTRAINT "futures_data_symbol_at_pk" PRIMARY KEY("symbol","at")
);
--> statement-breakpoint
CREATE TABLE "learning_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "learning_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"sample_size" integer NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "learning_state" (
	"session_id" text PRIMARY KEY NOT NULL,
	"weights_global" jsonb NOT NULL,
	"weights_by_symbol" jsonb NOT NULL,
	"weekly_delta" jsonb NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"confidence_by_symbol" jsonb NOT NULL,
	"trades_by_symbol" jsonb NOT NULL,
	"penalties" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"closed_trades" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_lease" (
	"session_id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_status" (
	"session_id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"last_heartbeat" timestamp with time zone NOT NULL,
	"phase" "bot_phase" NOT NULL,
	"warm_progress" integer DEFAULT 0 NOT NULL,
	"universe_size" integer DEFAULT 0 NOT NULL,
	"last_cycle_at" timestamp with time zone,
	"settings_version_applied" integer,
	"degraded_symbols" text[] NOT NULL,
	"flags" jsonb NOT NULL,
	"recent_errors" jsonb NOT NULL,
	"bot_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" "command_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "command_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"requested_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_history" ADD CONSTRAINT "settings_history_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_days" ADD CONSTRAINT "universe_days_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshot" ADD CONSTRAINT "market_snapshot_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_log" ADD CONSTRAINT "learning_log_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_state" ADD CONSTRAINT "learning_state_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_lease" ADD CONSTRAINT "bot_lease_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_status" ADD CONSTRAINT "bot_status_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_commands" ADD CONSTRAINT "bot_commands_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "positions_session_id_closed_at_idx" ON "positions" USING btree ("session_id","closed_at");--> statement-breakpoint
CREATE INDEX "position_events_position_id_at_idx" ON "position_events" USING btree ("position_id","at");--> statement-breakpoint
CREATE INDEX "decisions_session_id_candle_close_time_idx" ON "decisions" USING btree ("session_id","candle_close_time" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "equity_snapshots_session_id_at_idx" ON "equity_snapshots" USING btree ("session_id","at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "learning_log_session_id_at_idx" ON "learning_log" USING btree ("session_id","at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "bot_commands_session_id_status_created_at_idx" ON "bot_commands" USING btree ("session_id","status","created_at");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");