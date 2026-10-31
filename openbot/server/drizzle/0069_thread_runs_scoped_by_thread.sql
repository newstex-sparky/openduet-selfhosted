ALTER TABLE "copilotkit_thread_runs" DROP CONSTRAINT "copilotkit_thread_runs_pkey";--> statement-breakpoint
ALTER TABLE "copilotkit_thread_runs" ADD CONSTRAINT "copilotkit_thread_runs_thread_id_run_id_pk" PRIMARY KEY("thread_id","run_id");
