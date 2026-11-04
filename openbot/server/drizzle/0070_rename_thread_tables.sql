-- Rename the local-mode thread tables off the vendor's name.
--
-- 0068 created them as copilotkit_*. Nothing about the storage was ever CopilotKit's: the
-- tables, the queries and the lock are this deployment's own (toolkit/src/platform/
-- postgres-platform.ts). 0070 renames the tables and every index, key and constraint that
-- carries the old prefix, so a database created before this migration keeps its rows.

ALTER TABLE "copilotkit_threads" RENAME TO "openduet_threads";--> statement-breakpoint
ALTER TABLE "copilotkit_thread_messages" RENAME TO "openduet_thread_messages";--> statement-breakpoint
ALTER TABLE "copilotkit_thread_events" RENAME TO "openduet_thread_events";--> statement-breakpoint
ALTER TABLE "copilotkit_thread_runs" RENAME TO "openduet_thread_runs";--> statement-breakpoint
ALTER TABLE "copilotkit_thread_locks" RENAME TO "openduet_thread_locks";--> statement-breakpoint
ALTER INDEX "copilotkit_thread_events_thread_idx" RENAME TO "openduet_thread_events_thread_idx";--> statement-breakpoint
ALTER INDEX "copilotkit_thread_locks_expiry_idx" RENAME TO "openduet_thread_locks_expiry_idx";--> statement-breakpoint
ALTER INDEX "copilotkit_thread_messages_message_idx" RENAME TO "openduet_thread_messages_message_idx";--> statement-breakpoint
ALTER INDEX "copilotkit_thread_messages_thread_idx" RENAME TO "openduet_thread_messages_thread_idx";--> statement-breakpoint
ALTER INDEX "copilotkit_thread_runs_thread_idx" RENAME TO "openduet_thread_runs_thread_idx";--> statement-breakpoint
ALTER INDEX "copilotkit_threads_owner_updated_idx" RENAME TO "openduet_threads_owner_updated_idx";--> statement-breakpoint
ALTER INDEX "copilotkit_threads_updated_idx" RENAME TO "openduet_threads_updated_idx";--> statement-breakpoint
ALTER TABLE "openduet_thread_events" RENAME CONSTRAINT "copilotkit_thread_events_thread_id_copilotkit_threads_id_fk" TO "openduet_thread_events_thread_id_openduet_threads_id_fk";--> statement-breakpoint
ALTER TABLE "openduet_thread_locks" RENAME CONSTRAINT "copilotkit_thread_locks_thread_id_copilotkit_threads_id_fk" TO "openduet_thread_locks_thread_id_openduet_threads_id_fk";--> statement-breakpoint
ALTER TABLE "openduet_thread_messages" RENAME CONSTRAINT "copilotkit_thread_messages_thread_id_copilotkit_threads_id_fk" TO "openduet_thread_messages_thread_id_openduet_threads_id_fk";--> statement-breakpoint
ALTER TABLE "openduet_thread_runs" RENAME CONSTRAINT "copilotkit_thread_runs_thread_id_copilotkit_threads_id_fk" TO "openduet_thread_runs_thread_id_openduet_threads_id_fk";--> statement-breakpoint
ALTER TABLE "openduet_thread_runs" RENAME CONSTRAINT "copilotkit_thread_runs_status_check" TO "openduet_thread_runs_status_check";--> statement-breakpoint
ALTER TABLE "openduet_threads" RENAME CONSTRAINT "copilotkit_threads_pkey" TO "openduet_threads_pkey";--> statement-breakpoint
ALTER TABLE "openduet_thread_messages" RENAME CONSTRAINT "copilotkit_thread_messages_pkey" TO "openduet_thread_messages_pkey";--> statement-breakpoint
ALTER TABLE "openduet_thread_events" RENAME CONSTRAINT "copilotkit_thread_events_pkey" TO "openduet_thread_events_pkey";--> statement-breakpoint
ALTER TABLE "openduet_thread_locks" RENAME CONSTRAINT "copilotkit_thread_locks_pkey" TO "openduet_thread_locks_pkey";--> statement-breakpoint
ALTER TABLE "openduet_thread_runs" RENAME CONSTRAINT "copilotkit_thread_runs_thread_id_run_id_pk" TO "openduet_thread_runs_thread_id_run_id_pk";
