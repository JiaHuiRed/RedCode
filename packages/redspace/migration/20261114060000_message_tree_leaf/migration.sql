-- 261114 Red 消息树分支（Phase 2）：会话级可见路径叶指针。
-- backfill 取每会话时序最新一条（升级前全部是线性会话，最新 = 叶）；
-- 空会话保持 NULL。后续由写入方维护（每条新消息落库即推进）。
-- 决策：docs/notes/proposed/feature/2026-11-14-message-tree-branching.md
ALTER TABLE `session` ADD `leaf_message_id` text;--> statement-breakpoint
UPDATE `session` SET `leaf_message_id` = (
  SELECT `m`.`id` FROM `message` `m`
  WHERE `m`.`session_id` = `session`.`id`
  ORDER BY `m`.`time_created` DESC, `m`.`id` DESC
  LIMIT 1
) WHERE EXISTS (SELECT 1 FROM `message` WHERE `message`.`session_id` = `session`.`id`);