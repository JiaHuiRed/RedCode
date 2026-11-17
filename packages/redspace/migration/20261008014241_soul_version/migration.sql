CREATE TABLE `soul_version` (
	`hash` text PRIMARY KEY,
	`soul_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`commit_prefix` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "soul_version_hash_length_check" CHECK(length("hash") = 64),
	CONSTRAINT "soul_version_body_bytes_check" CHECK(length(cast("body" as blob)) <= 16384),
	CONSTRAINT "soul_version_name_bytes_check" CHECK(length(cast("name" as blob)) <= 256),
	CONSTRAINT "soul_version_display_name_bytes_check" CHECK("display_name" is null or length(cast("display_name" as blob)) <= 256),
	CONSTRAINT "soul_version_commit_prefix_bytes_check" CHECK("commit_prefix" is null or length(cast("commit_prefix" as blob)) <= 256)
);
--> statement-breakpoint
ALTER TABLE `session` ADD `soul_body_hash` text;