CREATE TABLE `github_handoffs` (
	`digest` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`issue` integer NOT NULL,
	`account_id` text NOT NULL,
	`login` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_provider` (
	`slot` integer PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`secret_box` text NOT NULL,
	`slug` text NOT NULL,
	`owner_id` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_sessions` (
	`digest` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`login` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `feedback_events` ADD `author_login` text DEFAULT '' NOT NULL;