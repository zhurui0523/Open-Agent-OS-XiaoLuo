CREATE TABLE `xiaoluo_v2_user_security_settings` (
	`user_id` varchar(36) NOT NULL,
	`allow_multiple_sessions` boolean NOT NULL DEFAULT true,
	`session_ttl_days` int unsigned NOT NULL DEFAULT 30,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_user_security_settings_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD `device_name` varchar(160);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD `user_agent` varchar(500);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD `ip_address` varchar(64);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_user_security_settings` ADD CONSTRAINT `xiaoluo_v2_user_security_settings_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;