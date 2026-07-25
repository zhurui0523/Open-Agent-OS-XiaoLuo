ALTER TABLE `xiaoluo_v2_package_capabilities` ADD `ports_json` longtext;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities` ADD `model_requirements_json` longtext;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities` ADD `execution_mode` varchar(20) NOT NULL DEFAULT 'model';--> statement-breakpoint
UPDATE `xiaoluo_v2_package_capabilities` SET `ports_json` = '[]' WHERE `ports_json` IS NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_package_capabilities` SET `model_requirements_json` = '{"required":true}' WHERE `model_requirements_json` IS NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_package_capabilities` AS `capability`
INNER JOIN `xiaoluo_v2_packages` AS `package`
  ON `package`.`id` = `capability`.`package_id`
SET
  `capability`.`execution_mode` = 'remote',
  `capability`.`model_requirements_json` = '{"required":false}'
WHERE `package`.`runtime_type` = 'remote-api';--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities` MODIFY `ports_json` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities` MODIFY `model_requirements_json` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `parameter_schema_json` longtext;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `ui_schema_json` longtext;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `capability_tags_json` text;--> statement-breakpoint
UPDATE `xiaoluo_v2_model_connections` SET `parameter_schema_json` = '{"type":"object","properties":{}}' WHERE `parameter_schema_json` IS NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_model_connections` SET `ui_schema_json` = '{}' WHERE `ui_schema_json` IS NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_model_connections` SET `capability_tags_json` = '[]' WHERE `capability_tags_json` IS NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` MODIFY `parameter_schema_json` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` MODIFY `ui_schema_json` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` MODIFY `capability_tags_json` text NOT NULL;
