ALTER TABLE `xiaoluo_v2_model_connections` ADD `input_constraints_json` longtext;--> statement-breakpoint
UPDATE `xiaoluo_v2_model_connections` SET `input_constraints_json` = '{}' WHERE `input_constraints_json` IS NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` MODIFY `input_constraints_json` longtext NOT NULL;
