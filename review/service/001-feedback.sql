CREATE TABLE `feedback_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue` integer NOT NULL,
	`lane` text NOT NULL,
	`author` text NOT NULL,
	`request_id` text NOT NULL,
	`revision` text NOT NULL,
	`action` text NOT NULL,
	`asset` text NOT NULL,
	`choice` text NOT NULL,
	`note` text NOT NULL,
	`position_ms` integer NOT NULL,
	`previous` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_request` ON `feedback_events` (`issue`,`lane`,`author`,`request_id`);--> statement-breakpoint
CREATE INDEX `feedback_stream` ON `feedback_events` (`issue`,`lane`,`seq`);--> statement-breakpoint
CREATE INDEX `feedback_move` ON `feedback_events` (`issue`,`lane`,`author`,`action`,`seq`);