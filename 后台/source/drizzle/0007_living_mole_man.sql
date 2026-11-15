CREATE TABLE `xiaoluo_v2_audit_logs` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36),
	`actor_user_id` varchar(36),
	`event_type` varchar(120) NOT NULL,
	`entity_type` varchar(80) NOT NULL,
	`entity_id` varchar(160) NOT NULL,
	`request_id` varchar(120),
	`detail_json` longtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_outbox_events` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36),
	`aggregate_type` varchar(80) NOT NULL,
	`aggregate_id` varchar(160) NOT NULL,
	`event_type` varchar(120) NOT NULL,
	`payload_json` longtext NOT NULL,
	`status` enum('pending','processing','published','failed') NOT NULL DEFAULT 'pending',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`available_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`claimed_at` datetime(3),
	`published_at` datetime(3),
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_outbox_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_audit_logs` ADD CONSTRAINT `audit_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_audit_logs` ADD CONSTRAINT `audit_actor_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_outbox_events` ADD CONSTRAINT `outbox_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_workspace_created_idx` ON `xiaoluo_v2_audit_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_actor_created_idx` ON `xiaoluo_v2_audit_logs` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `xiaoluo_v2_audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `outbox_delivery_idx` ON `xiaoluo_v2_outbox_events` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_aggregate_idx` ON `xiaoluo_v2_outbox_events` (`aggregate_type`,`aggregate_id`);
