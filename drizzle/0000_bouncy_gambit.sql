CREATE TYPE "public"."alarm_severity" AS ENUM('INFO', 'WARN', 'CRIT');--> statement-breakpoint
CREATE TYPE "public"."alarm_source" AS ENUM('EDGE', 'SYSTEM', 'SIMULATION');--> statement-breakpoint
CREATE TYPE "public"."alarm_state" AS ENUM('ACTIVE', 'ACKNOWLEDGED', 'CLEARED');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('ACTIVE', 'ROTATED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."data_quality" AS ENUM('GOOD', 'UNCERTAIN', 'BAD', 'STALE');--> statement-breakpoint
CREATE TYPE "public"."device_category" AS ENUM('Chiller', 'CHW Pump', 'CW Pump', 'Cooling Tower', 'Aux Equipment', 'Valves');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('RUNNING', 'STANDBY', 'ISOLATED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('VIEWER', 'OPERATOR', 'ADMIN');--> statement-breakpoint
CREATE TABLE "device_current_states" (
	"device_id" varchar(64) PRIMARY KEY NOT NULL,
	"plant_id" integer NOT NULL,
	"status" "device_status" DEFAULT 'STANDBY' NOT NULL,
	"quality" "data_quality" DEFAULT 'GOOD' NOT NULL,
	"load_pct" real DEFAULT 0 NOT NULL,
	"run_hours" integer DEFAULT 0 NOT NULL,
	"live_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sequence_number" integer DEFAULT 0 NOT NULL,
	"edge_device_id" varchar(64),
	"payload_version" varchar(24)
);
--> statement-breakpoint
CREATE TABLE "device_telemetry_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"plant_id" integer NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"source_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quality" "data_quality" DEFAULT 'GOOD' NOT NULL,
	"sequence_number" integer DEFAULT 0 NOT NULL,
	"edge_device_id" varchar(64),
	"payload_version" varchar(24),
	"idempotency_key" varchar(128),
	"status" "device_status" NOT NULL,
	"load_pct" real NOT NULL,
	"power_kw" real,
	"capacity_kw" real,
	"cop" real,
	"chw_out_c" real,
	"chw_in_c" real,
	"cw_in_c" real,
	"cw_out_c" real,
	"flow_m3h" real,
	"extra_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edge_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"credential_id" varchar(64) NOT NULL,
	"plant_id" integer NOT NULL,
	"edge_device_id" varchar(64) NOT NULL,
	"label" varchar(120) NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_salt" text NOT NULL,
	"status" "credential_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_used_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "plant_alarms" (
	"id" serial PRIMARY KEY NOT NULL,
	"plant_id" integer NOT NULL,
	"device_id" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" "alarm_severity" DEFAULT 'INFO' NOT NULL,
	"state" "alarm_state" DEFAULT 'ACTIVE' NOT NULL,
	"source_type" "alarm_source" DEFAULT 'EDGE' NOT NULL,
	"dedupe_key" varchar(128),
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"message" text NOT NULL,
	"source" varchar(80) NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"cleared_at" timestamp with time zone,
	"cleared_by" text
);
--> statement-breakpoint
CREATE TABLE "plant_devices" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"plant_id" integer NOT NULL,
	"device_key" varchar(32) NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(100) NOT NULL,
	"category" "device_category" NOT NULL,
	"mesh_key" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"design_specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plant_kpi_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"plant_id" integer NOT NULL,
	"source_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quality" "data_quality" DEFAULT 'GOOD' NOT NULL,
	"sequence_number" integer DEFAULT 0 NOT NULL,
	"edge_device_id" varchar(64),
	"payload_version" varchar(24),
	"idempotency_key" varchar(128),
	"is_simulated" boolean DEFAULT false NOT NULL,
	"scenario" varchar(32) DEFAULT 'Steady State' NOT NULL,
	"cooling_load_mw" real NOT NULL,
	"total_power_mw" real NOT NULL,
	"system_cop" real NOT NULL,
	"wet_bulb_c" real NOT NULL,
	"chw_supply_c" real NOT NULL,
	"chw_return_c" real NOT NULL,
	"delta_t_k" real NOT NULL,
	"cw_supply_c" real NOT NULL,
	"tower_approach_k" real NOT NULL,
	"chillers_on" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plants" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "telemetry_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"plant_id" integer NOT NULL,
	"edge_device_id" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"sequence_number" integer NOT NULL,
	"payload_version" varchar(24) NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sample_count" integer NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_plant_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"plant_id" integer NOT NULL,
	"role" "user_role" DEFAULT 'VIEWER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uid" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
ALTER TABLE "device_current_states" ADD CONSTRAINT "device_current_states_device_id_plant_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."plant_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_current_states" ADD CONSTRAINT "device_current_states_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_telemetry_samples" ADD CONSTRAINT "device_telemetry_samples_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_telemetry_samples" ADD CONSTRAINT "device_telemetry_samples_device_id_plant_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."plant_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_credentials" ADD CONSTRAINT "edge_credentials_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_alarms" ADD CONSTRAINT "plant_alarms_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_alarms" ADD CONSTRAINT "plant_alarms_device_id_plant_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."plant_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_devices" ADD CONSTRAINT "plant_devices_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_kpi_snapshots" ADD CONSTRAINT "plant_kpi_snapshots_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_batches" ADD CONSTRAINT "telemetry_batches_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plant_roles" ADD CONSTRAINT "user_plant_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plant_roles" ADD CONSTRAINT "user_plant_roles_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_current_plant_ts" ON "device_current_states" USING btree ("plant_id","source_timestamp");--> statement-breakpoint
CREATE INDEX "idx_dev_telemetry_plant_device_time" ON "device_telemetry_samples" USING btree ("plant_id","device_id","source_timestamp");--> statement-breakpoint
CREATE INDEX "idx_dev_telemetry_device_time" ON "device_telemetry_samples" USING btree ("device_id","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_edge_credentials_plant" ON "edge_credentials" USING btree ("plant_id","status");--> statement-breakpoint
CREATE INDEX "idx_plant_alarms_occurred" ON "plant_alarms" USING btree ("plant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_plant_alarms_dedupe" ON "plant_alarms" USING btree ("plant_id","dedupe_key","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plant_devices_plant_key" ON "plant_devices" USING btree ("plant_id","device_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plant_devices_plant_code" ON "plant_devices" USING btree ("plant_id","code");--> statement-breakpoint
CREATE INDEX "idx_plant_devices_plant_cat" ON "plant_devices" USING btree ("plant_id","category","sort_order");--> statement-breakpoint
CREATE INDEX "idx_plant_kpi_plant_time" ON "plant_kpi_snapshots" USING btree ("plant_id","source_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_telemetry_batches_idem" ON "telemetry_batches" USING btree ("plant_id","edge_device_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_telemetry_batches_plant_time" ON "telemetry_batches" USING btree ("plant_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_plant_role" ON "user_plant_roles" USING btree ("user_id","plant_id");