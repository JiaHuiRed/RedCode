CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY,
	`room_id` text NOT NULL,
	`sender` text NOT NULL,
	`text` text,
	`content_type` text DEFAULT 'text' NOT NULL,
	`session_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_chat_message_room_id_chat_room_id_fk` FOREIGN KEY (`room_id`) REFERENCES `chat_room`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chat_room` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_chat_room_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `chat_message_room_time_idx` ON `chat_message` (`room_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `chat_message_session_idx` ON `chat_message` (`session_id`);--> statement-breakpoint
CREATE INDEX `chat_room_project_idx` ON `chat_room` (`project_id`);