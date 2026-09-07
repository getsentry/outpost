CREATE TABLE `agent_lifecycle` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`destroyed_at` integer,
	`updated_at` integer NOT NULL
);
