CREATE TABLE `github_discussion_obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`entity_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_comment_id` text NOT NULL,
	`reply_to_comment_id` text,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`url` text,
	`event_id` text NOT NULL,
	`installation_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`verified_at` integer,
	`reminder_count` integer DEFAULT 0 NOT NULL,
	`last_reminded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_discussion_obligations_repo_source_unique` ON `github_discussion_obligations` (`repo`,`source_kind`,`source_comment_id`);--> statement-breakpoint
CREATE INDEX `idx_github_discussion_obligations_entity_status` ON `github_discussion_obligations` (`entity_key`,`status`);
