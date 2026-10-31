CREATE TABLE "copilotkit_thread_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilotkit_thread_locks" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilotkit_thread_messages" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilotkit_thread_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text,
	"agent_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "copilotkit_thread_runs_status_check" CHECK ("copilotkit_thread_runs"."status" IN ('running', 'finished', 'error', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "copilotkit_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"agent_id" text NOT NULL,
	"name" text,
	"organization_id" text DEFAULT '' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilotkit_thread_events" ADD CONSTRAINT "copilotkit_thread_events_thread_id_copilotkit_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."copilotkit_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilotkit_thread_locks" ADD CONSTRAINT "copilotkit_thread_locks_thread_id_copilotkit_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."copilotkit_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilotkit_thread_messages" ADD CONSTRAINT "copilotkit_thread_messages_thread_id_copilotkit_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."copilotkit_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilotkit_thread_runs" ADD CONSTRAINT "copilotkit_thread_runs_thread_id_copilotkit_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."copilotkit_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copilotkit_thread_events_thread_idx" ON "copilotkit_thread_events" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "copilotkit_thread_locks_expiry_idx" ON "copilotkit_thread_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copilotkit_thread_messages_message_idx" ON "copilotkit_thread_messages" USING btree ("thread_id","message_id");--> statement-breakpoint
CREATE INDEX "copilotkit_thread_messages_thread_idx" ON "copilotkit_thread_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "copilotkit_thread_runs_thread_idx" ON "copilotkit_thread_runs" USING btree ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "copilotkit_threads_owner_updated_idx" ON "copilotkit_threads" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "copilotkit_threads_updated_idx" ON "copilotkit_threads" USING btree ("updated_at");