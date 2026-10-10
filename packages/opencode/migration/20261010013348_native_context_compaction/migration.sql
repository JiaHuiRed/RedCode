CREATE TABLE `context_compaction_block` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`active` integer NOT NULL,
	`committed_at` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_context_compaction_block_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `context_compaction_session_active_idx` ON `context_compaction_block` (`session_id`,`active`);--> statement-breakpoint
CREATE INDEX `context_compaction_session_request_idx` ON `context_compaction_block` (`session_id`,`request_id`);