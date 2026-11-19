CREATE TABLE `commitment` (
	`id` text PRIMARY KEY,
	`companion_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`sensitivity` text NOT NULL,
	`text` text NOT NULL,
	`reason` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`due_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`delivered_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `commitment_scope_status_due_idx` ON `commitment` (`companion_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `commitment_scope_dedupe_idx` ON `commitment` (`companion_id`,`dedupe_key`);