CREATE INDEX `asset_folders_parent_id_idx` ON `asset_folders` (`parent_id`);--> statement-breakpoint
CREATE INDEX `asset_relations_from_idx` ON `asset_relations` (`from_asset_id`);--> statement-breakpoint
CREATE INDEX `asset_relations_to_idx` ON `asset_relations` (`to_asset_id`);--> statement-breakpoint
CREATE INDEX `asset_versions_asset_id_idx` ON `asset_versions` (`asset_id`);--> statement-breakpoint
CREATE INDEX `asset_versions_content_hash_idx` ON `asset_versions` (`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_asset_version_unique` ON `asset_versions` (`asset_id`,`version`);--> statement-breakpoint
CREATE INDEX `assets_folder_id_idx` ON `assets` (`folder_id`);--> statement-breakpoint
CREATE INDEX `assets_content_hash_idx` ON `assets` (`content_hash`);