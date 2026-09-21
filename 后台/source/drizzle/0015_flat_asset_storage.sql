DROP TABLE IF EXISTS `xiaoluo_v2_asset_collection_items`;--> statement-breakpoint
DROP TABLE IF EXISTS `xiaoluo_v2_asset_collections`;--> statement-breakpoint
DROP TABLE IF EXISTS `xiaoluo_v2_asset_folders`;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_assets` DROP INDEX `assets_folder_idx`;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_assets` DROP COLUMN `folder_id`;
