-- Destructive rollback. Back up the database before running this file.
DROP TABLE IF EXISTS `xiaoluo_v2_asset_collection_items`;
DROP TABLE IF EXISTS `xiaoluo_v2_asset_collections`;
DROP TABLE IF EXISTS `xiaoluo_v2_canvas_snapshots`;
DROP TABLE IF EXISTS `xiaoluo_v2_generation_jobs`;
DROP TABLE IF EXISTS `xiaoluo_v2_intent_messages`;
DROP TABLE IF EXISTS `xiaoluo_v2_intent_plans`;
DROP TABLE IF EXISTS `xiaoluo_v2_intent_conversations`;
DROP TABLE IF EXISTS `xiaoluo_v2_package_versions`;
DROP TABLE IF EXISTS `xiaoluo_v2_run_events`;
DROP TABLE IF EXISTS `xiaoluo_v2_secret_refs`;

ALTER TABLE `xiaoluo_v2_assets`
  DROP COLUMN `favorite`,
  DROP COLUMN `missing_at`;
ALTER TABLE `xiaoluo_v2_canvases`
  DROP COLUMN `archived_at`,
  DROP COLUMN `starred`;
ALTER TABLE `xiaoluo_v2_projects`
  DROP COLUMN `status`,
  DROP COLUMN `deleted_at`;
ALTER TABLE `xiaoluo_v2_workspaces`
  DROP COLUMN `status`,
  DROP COLUMN `deleted_at`;
