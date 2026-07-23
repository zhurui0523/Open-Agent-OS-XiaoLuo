CREATE TABLE `asset_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`from_asset_id` text NOT NULL,
	`to_asset_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`from_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	`blob_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`source_type` text DEFAULT 'upload' NOT NULL,
	`source_ref` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`uri` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`folder_id` text,
	`current_version_id` text,
	`current_version` integer DEFAULT 1 NOT NULL,
	`version_count` integer DEFAULT 1 NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`source_type` text DEFAULT 'upload' NOT NULL,
	`source_ref` text,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`trashed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_uri_unique` ON `assets` (`uri`);