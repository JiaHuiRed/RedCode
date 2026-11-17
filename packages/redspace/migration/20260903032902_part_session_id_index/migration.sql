DROP INDEX IF EXISTS `part_session_idx`;--> statement-breakpoint
CREATE INDEX `part_session_id_id_idx` ON `part` (`session_id`,`id`);