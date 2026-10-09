CREATE TABLE `session_change` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`message_id` text,
	`time_created` integer NOT NULL,
	CONSTRAINT `session_change_pk` PRIMARY KEY(`session_id`, `seq`),
	CONSTRAINT `fk_session_change_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_change_time_created_id_idx` ON `session_change` (`time_created`,`id`);