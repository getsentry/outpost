CREATE TABLE `agent_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`work_key` text NOT NULL,
	`entity_key` text NOT NULL,
	`repo` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`goal` text NOT NULL,
	`target_pr_number` integer,
	`stage` text DEFAULT 'queued' NOT NULL,
	`artifact_url` text,
	`artifact_sha` text,
	`blocker` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_work_items_repo_source_unique` ON `agent_work_items` (`repo`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_work_items_work_stage_updated` ON `agent_work_items` (`work_key`,`stage`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_work_items_entity_stage_updated` ON `agent_work_items` (`entity_key`,`stage`,`updated_at`);