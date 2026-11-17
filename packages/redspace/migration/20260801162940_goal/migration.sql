CREATE TABLE `goal` (
	`session_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_goal_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
