CREATE TABLE `maintenance_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`cron` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`outcome` text NOT NULL
);
