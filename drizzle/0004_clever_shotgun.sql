ALTER TABLE `xiaoluo_v2_auth_sessions` ADD `refresh_token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD `refresh_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD `refresh_rotated_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_users` ADD `username` varchar(32);--> statement-breakpoint
UPDATE `xiaoluo_v2_users`
SET `username` = CONCAT('u', LEFT(REPLACE(`id`, '-', ''), 31))
WHERE `username` IS NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_users` AS `u`
INNER JOIN (
  SELECT LOWER(`display_name`) AS `candidate`
  FROM `xiaoluo_v2_users`
  WHERE LOWER(`display_name`) REGEXP '^[a-z0-9][a-z0-9_]{2,31}$'
    AND LOWER(`display_name`) NOT REGEXP '^u[0-9a-f]{31}$'
  GROUP BY LOWER(`display_name`)
  HAVING COUNT(*) = 1
) AS `valid_names`
  ON `valid_names`.`candidate` = LOWER(`u`.`display_name`)
SET `u`.`username` = `valid_names`.`candidate`;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_users`
MODIFY `username` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD CONSTRAINT `xiaoluo_v2_auth_sessions_refresh_token_hash_unique` UNIQUE(`refresh_token_hash`);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_users` ADD CONSTRAINT `xiaoluo_v2_users_username_unique` UNIQUE(`username`);--> statement-breakpoint
CREATE INDEX `auth_sessions_refresh_expiry_idx` ON `xiaoluo_v2_auth_sessions` (`refresh_expires_at`);
