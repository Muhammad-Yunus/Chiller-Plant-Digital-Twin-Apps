CREATE TYPE "public"."credential_type" AS ENUM('EDGE', 'SIMULATION');--> statement-breakpoint
CREATE TYPE "public"."data_source" AS ENUM('EDGE', 'SIMULATION', 'SEED');--> statement-breakpoint
ALTER TABLE "device_current_states" ADD COLUMN "is_simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_current_states" ADD COLUMN "source_type" "data_source" DEFAULT 'EDGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_telemetry_samples" ADD COLUMN "is_simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_telemetry_samples" ADD COLUMN "source_type" "data_source" DEFAULT 'EDGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "edge_credentials" ADD COLUMN "credential_type" "credential_type" DEFAULT 'EDGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "plant_kpi_snapshots" ADD COLUMN "source_type" "data_source" DEFAULT 'EDGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_batches" ADD COLUMN "payload_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "telemetry_batches" ADD COLUMN "source_type" "data_source" DEFAULT 'EDGE' NOT NULL;