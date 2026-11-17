CREATE INDEX `message_pending_steer_idx` ON `message` (`session_id`) WHERE json_extract("message"."data", '$.delivery') = 'pending_steer';--> statement-breakpoint
CREATE INDEX `part_session_tool_idx` ON `part` (`session_id`,`message_id`,`id`) WHERE json_extract("part"."data", '$.type') = 'tool';--> statement-breakpoint
-- 261105 Red partial index 需要统计信息才会被查询优化器选中：无 sqlite_stat1 时实测仍走
-- 旧索引并逐行 json_extract（2612 条会话 50ms/步）。ANALYZE 只统计这两张表，实测 <1s。
ANALYZE `message`;--> statement-breakpoint
ANALYZE `part`;