ALTER TABLE `xiaoluo_v2_secret_refs` ADD `purpose` varchar(32) NOT NULL DEFAULT 'generic' AFTER `name`;--> statement-breakpoint
UPDATE `xiaoluo_v2_secret_refs` AS `secret`
INNER JOIN `xiaoluo_v2_model_connections` AS `model`
  ON `model`.`secret_ref_id` = `secret`.`id`
SET `secret`.`purpose` = 'model_api_key';--> statement-breakpoint
CREATE UNIQUE INDEX `secret_refs_owner_purpose_name_unique` ON `xiaoluo_v2_secret_refs` (`workspace_id`, `created_by`, `purpose`, `name`);--> statement-breakpoint
CREATE INDEX `secret_refs_workspace_owner_idx` ON `xiaoluo_v2_secret_refs` (`workspace_id`, `created_by`);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_secret_refs` DROP INDEX `secret_refs_workspace_name_unique`;
