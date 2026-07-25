CREATE TABLE `xiaoluo_v2_user_preferences` (
	`user_id` varchar(36) NOT NULL,
	`settings_json` longtext NOT NULL,
	`revision` bigint unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_user_preferences_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_user_preferences` ADD CONSTRAINT `xiaoluo_v2_user_preferences_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;