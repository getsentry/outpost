CREATE TABLE `scheduled_job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`trigger` text NOT NULL,
	`intended_at` integer NOT NULL,
	`repo` text NOT NULL,
	`prompt` text NOT NULL,
	`entity_key` text,
	`flue_submission_id` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`artifact_url` text,
	`artifact_kind` text,
	`started_at` integer,
	`admitted_at` integer,
	`settled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_job_runs_schedule_dedupe_unique` ON `scheduled_job_runs` (`schedule_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_job_runs_schedule_created` ON `scheduled_job_runs` (`schedule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_job_runs_status_updated` ON `scheduled_job_runs` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_job_runs_entity_unique` ON `scheduled_job_runs` (`entity_key`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo` text NOT NULL,
	`prompt` text NOT NULL,
	`cadence` text NOT NULL,
	`local_time` text NOT NULL,
	`timezone` text NOT NULL,
	`day_of_week` integer,
	`day_of_month` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`next_due_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_jobs_enabled_due` ON `scheduled_jobs` (`enabled`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_jobs_archived_updated` ON `scheduled_jobs` (`archived_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `scheduled_run_slots` (
	`slot` integer PRIMARY KEY NOT NULL,
	`run_id` text,
	`lease_expires_at` integer
);
--> statement-breakpoint
INSERT INTO `scheduled_run_slots` (`slot`) VALUES (1), (2), (3);
