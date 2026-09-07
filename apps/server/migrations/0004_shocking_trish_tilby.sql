ALTER TABLE `webhook_events` ADD `flue_submission_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_events_flue_submission_id` ON `webhook_events` (`flue_submission_id`);