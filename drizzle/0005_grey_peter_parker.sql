CREATE TABLE `xiaoluo_v2_model_catalog_entries` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`connection_id` varchar(120) NOT NULL,
	`model_id` varchar(240) NOT NULL,
	`display_name` varchar(240) NOT NULL,
	`modalities_json` text NOT NULL,
	`available` boolean NOT NULL DEFAULT true,
	`metadata_json` longtext NOT NULL,
	`discovered_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_model_catalog_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_catalog_connection_model_unique` UNIQUE(`connection_id`,`model_id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_model_execution_audits` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`run_id` varchar(120),
	`node_id` varchar(120),
	`requested_connection_id` varchar(120),
	`actual_connection_id` varchar(120),
	`model_name` varchar(240) NOT NULL,
	`modality` varchar(20) NOT NULL,
	`status` varchar(32) NOT NULL,
	`attempts` int unsigned NOT NULL DEFAULT 1,
	`fallback_used` boolean NOT NULL DEFAULT false,
	`latency_ms` int unsigned,
	`error_code` varchar(80),
	`error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	CONSTRAINT `xiaoluo_v2_model_execution_audits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_model_usage_stats` (
	`workspace_id` varchar(36) NOT NULL,
	`connection_id` varchar(120) NOT NULL,
	`usage_day` varchar(10) NOT NULL,
	`modality` varchar(20) NOT NULL,
	`total_count` bigint unsigned NOT NULL DEFAULT 0,
	`success_count` bigint unsigned NOT NULL DEFAULT 0,
	`failure_count` bigint unsigned NOT NULL DEFAULT 0,
	`retry_count` bigint unsigned NOT NULL DEFAULT 0,
	`fallback_count` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `model_usage_stats_pk` PRIMARY KEY(`workspace_id`,`connection_id`,`usage_day`,`modality`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `model_connection_id` varchar(120);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `poll_url` text;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `cancel_url` text;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `provider_status` varchar(80);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `poll_count` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `max_polls` int unsigned DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `next_poll_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `last_polled_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `max_concurrency` int unsigned DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `retry_limit` int unsigned DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `circuit_failure_threshold` int unsigned DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `circuit_cooldown_seconds` int unsigned DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `circuit_state` varchar(20) DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `circuit_failure_count` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `circuit_opened_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `active_requests` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `last_success_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `last_failure_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `catalog_synced_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_catalog_entries` ADD CONSTRAINT `model_catalog_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_catalog_entries` ADD CONSTRAINT `model_catalog_connection_fk` FOREIGN KEY (`connection_id`) REFERENCES `xiaoluo_v2_model_connections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_execution_audits` ADD CONSTRAINT `model_audit_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_execution_audits` ADD CONSTRAINT `model_audit_user_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_usage_stats` ADD CONSTRAINT `model_usage_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `model_catalog_workspace_available_idx` ON `xiaoluo_v2_model_catalog_entries` (`workspace_id`,`available`);--> statement-breakpoint
CREATE INDEX `model_audits_workspace_created_idx` ON `xiaoluo_v2_model_execution_audits` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `model_audits_run_idx` ON `xiaoluo_v2_model_execution_audits` (`run_id`);--> statement-breakpoint
CREATE INDEX `model_usage_workspace_day_idx` ON `xiaoluo_v2_model_usage_stats` (`workspace_id`,`usage_day`);--> statement-breakpoint
CREATE INDEX `model_connections_workspace_priority_idx` ON `xiaoluo_v2_model_connections` (`workspace_id`,`enabled`,`priority`);--> statement-breakpoint
CREATE INDEX `model_connections_circuit_idx` ON `xiaoluo_v2_model_connections` (`workspace_id`,`circuit_state`);
