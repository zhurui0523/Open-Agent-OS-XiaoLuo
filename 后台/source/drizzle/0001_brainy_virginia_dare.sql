CREATE TABLE `xiaoluo_v2_asset_collection_items` (
	`collection_id` varchar(120) NOT NULL,
	`asset_id` varchar(120) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_asset_collection_items_collection_id_asset_id_pk` PRIMARY KEY(`collection_id`,`asset_id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_asset_collections` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(180) NOT NULL,
	`description` text NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_asset_collections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_canvas_snapshots` (
	`id` varchar(120) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`revision` bigint unsigned NOT NULL,
	`label` varchar(180) NOT NULL,
	`graph_json` longtext NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_canvas_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_generation_jobs` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`requested_by` varchar(36) NOT NULL,
	`run_id` varchar(120),
	`node_id` varchar(120),
	`kind` varchar(32) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`progress` int unsigned NOT NULL DEFAULT 0,
	`provider` varchar(120) NOT NULL,
	`external_job_id` varchar(240),
	`input_json` longtext NOT NULL,
	`output_json` longtext,
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_generation_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_intent_conversations` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`title` varchar(180) NOT NULL,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_intent_conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_intent_messages` (
	`id` varchar(120) NOT NULL,
	`conversation_id` varchar(120) NOT NULL,
	`role` enum('user','assistant','system') NOT NULL,
	`content` longtext NOT NULL,
	`metadata_json` longtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_intent_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_intent_plans` (
	`id` varchar(120) NOT NULL,
	`conversation_id` varchar(120) NOT NULL,
	`version` int unsigned NOT NULL,
	`status` enum('draft','awaiting_confirmation','confirmed','rejected') NOT NULL DEFAULT 'draft',
	`goal` text NOT NULL,
	`plan_json` longtext NOT NULL,
	`planner` varchar(180) NOT NULL,
	`confirmed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_intent_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `intent_plans_conversation_version_unique` UNIQUE(`conversation_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_package_versions` (
	`id` varchar(120) NOT NULL,
	`package_id` varchar(120) NOT NULL,
	`version` varchar(80) NOT NULL,
	`manifest_json` longtext NOT NULL,
	`permissions_json` longtext NOT NULL,
	`integrity_sha256` varchar(64) NOT NULL,
	`signature` text,
	`installed_by` varchar(36) NOT NULL,
	`installed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_package_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `package_versions_package_version_unique` UNIQUE(`package_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_run_events` (
	`id` varchar(120) NOT NULL,
	`run_id` varchar(120) NOT NULL,
	`event_type` varchar(120) NOT NULL,
	`node_id` varchar(120),
	`payload_json` longtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_run_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_secret_refs` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`ciphertext` longtext NOT NULL,
	`iv` varchar(64) NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`last_used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_secret_refs_id` PRIMARY KEY(`id`),
	CONSTRAINT `secret_refs_workspace_name_unique` UNIQUE(`workspace_id`,`name`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_assets` ADD `favorite` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_assets` ADD `missing_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvases` ADD `archived_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvases` ADD `starred` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `workspace_id` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `created_by` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `canvas_id` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `idempotency_key` varchar(160);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `desired_status` varchar(32) DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `lease_owner` varchar(160);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `lease_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD `heartbeat_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_tasks` ADD `attempt` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_tasks` ADD `max_attempts` int unsigned DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_tasks` ADD `lease_owner` varchar(160);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_tasks` ADD `lease_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `workspace_id` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `created_by` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `secret_ref_id` varchar(120);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `priority` int DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD `fallback_model_id` varchar(120);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities` ADD `capability_key` varchar(200);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `package_key` varchar(160);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `workspace_id` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `created_by` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `lifecycle_state` varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `health_status` varchar(32) DEFAULT 'unchecked' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `integrity_sha256` varchar(64);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `signature` text;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_projects` ADD `status` enum('active','archived','trashed') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_projects` ADD `deleted_at` datetime(3);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_registry_events` ADD `workspace_id` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_registry_events` ADD `actor_user_id` varchar(36);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_workspaces` ADD `status` enum('active','archived','trashed') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_workspaces` ADD `deleted_at` datetime(3);--> statement-breakpoint
UPDATE `xiaoluo_v2_packages`
SET `package_key` = `id`,
    `workspace_id` = COALESCE(
      `workspace_id`,
      (SELECT `id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    ),
    `created_by` = COALESCE(
      `created_by`,
      (SELECT `owner_id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    ),
    `integrity_sha256` = SHA2(`manifest_json`, 256);--> statement-breakpoint
UPDATE `xiaoluo_v2_package_capabilities`
SET `capability_key` = `id`;--> statement-breakpoint
UPDATE `xiaoluo_v2_model_connections`
SET `workspace_id` = COALESCE(
      `workspace_id`,
      (SELECT `id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    ),
    `created_by` = COALESCE(
      `created_by`,
      (SELECT `owner_id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    );--> statement-breakpoint
UPDATE `xiaoluo_v2_kernel_runs`
SET `workspace_id` = COALESCE(
      `workspace_id`,
      (SELECT `id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    ),
    `created_by` = COALESCE(
      `created_by`,
      (SELECT `owner_id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    ),
    `idempotency_key` = COALESCE(
      `idempotency_key`,
      CONCAT('legacy:', `id`)
    );--> statement-breakpoint
UPDATE `xiaoluo_v2_registry_events`
SET `workspace_id` = COALESCE(
      `workspace_id`,
      (SELECT `id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    ),
    `actor_user_id` = COALESCE(
      `actor_user_id`,
      (SELECT `owner_id` FROM `xiaoluo_v2_workspaces` ORDER BY `created_at` LIMIT 1)
    );--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages`
  MODIFY `package_key` varchar(160) NOT NULL,
  MODIFY `workspace_id` varchar(36) NOT NULL,
  MODIFY `created_by` varchar(36) NOT NULL,
  MODIFY `integrity_sha256` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities`
  MODIFY `capability_key` varchar(200) NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections`
  MODIFY `workspace_id` varchar(36) NOT NULL,
  MODIFY `created_by` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs`
  MODIFY `workspace_id` varchar(36) NOT NULL,
  MODIFY `created_by` varchar(36) NOT NULL,
  MODIFY `idempotency_key` varchar(160) NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_registry_events`
  MODIFY `workspace_id` varchar(36) NOT NULL,
  MODIFY `actor_user_id` varchar(36) NOT NULL;--> statement-breakpoint
INSERT IGNORE INTO `xiaoluo_v2_package_versions`
  (`id`, `package_id`, `version`, `manifest_json`, `permissions_json`,
   `integrity_sha256`, `signature`, `installed_by`, `installed_at`)
SELECT
  CONCAT('legacy_version_', LEFT(SHA2(CONCAT(`id`, ':', `version`), 256), 32)),
  `id`,
  `version`,
  `manifest_json`,
  `permissions_json`,
  `integrity_sha256`,
  `signature`,
  `created_by`,
  `installed_at`
FROM `xiaoluo_v2_packages`;--> statement-breakpoint
CREATE UNIQUE INDEX `packages_workspace_key_unique`
  ON `xiaoluo_v2_packages` (`workspace_id`, `package_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_runs_creator_idempotency_unique`
  ON `xiaoluo_v2_kernel_runs` (`created_by`, `idempotency_key`);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_collection_items` ADD CONSTRAINT `fk_collection_items_collection` FOREIGN KEY (`collection_id`) REFERENCES `xiaoluo_v2_asset_collections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_collection_items` ADD CONSTRAINT `fk_collection_items_asset` FOREIGN KEY (`asset_id`) REFERENCES `xiaoluo_v2_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_collections` ADD CONSTRAINT `fk_asset_collections_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_collections` ADD CONSTRAINT `xiaoluo_v2_asset_collections_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_snapshots` ADD CONSTRAINT `xiaoluo_v2_canvas_snapshots_canvas_id_xiaoluo_v2_canvases_id_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_snapshots` ADD CONSTRAINT `xiaoluo_v2_canvas_snapshots_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD CONSTRAINT `fk_generation_jobs_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD CONSTRAINT `xiaoluo_v2_generation_jobs_requested_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD CONSTRAINT `xiaoluo_v2_generation_jobs_run_id_xiaoluo_v2_kernel_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `xiaoluo_v2_kernel_runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_intent_conversations` ADD CONSTRAINT `fk_intent_conversations_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_intent_conversations` ADD CONSTRAINT `fk_intent_conversations_canvas` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_intent_conversations` ADD CONSTRAINT `fk_intent_conversations_creator` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_intent_messages` ADD CONSTRAINT `fk_intent_messages_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `xiaoluo_v2_intent_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_intent_plans` ADD CONSTRAINT `fk_intent_plans_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `xiaoluo_v2_intent_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_versions` ADD CONSTRAINT `xiaoluo_v2_package_versions_package_id_xiaoluo_v2_packages_id_fk` FOREIGN KEY (`package_id`) REFERENCES `xiaoluo_v2_packages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_versions` ADD CONSTRAINT `xiaoluo_v2_package_versions_installed_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`installed_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_run_events` ADD CONSTRAINT `xiaoluo_v2_run_events_run_id_xiaoluo_v2_kernel_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `xiaoluo_v2_kernel_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_secret_refs` ADD CONSTRAINT `xiaoluo_v2_secret_refs_workspace_id_xiaoluo_v2_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_secret_refs` ADD CONSTRAINT `xiaoluo_v2_secret_refs_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `asset_collections_workspace_idx` ON `xiaoluo_v2_asset_collections` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `canvas_snapshots_canvas_idx` ON `xiaoluo_v2_canvas_snapshots` (`canvas_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `generation_jobs_workspace_status_idx` ON `xiaoluo_v2_generation_jobs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `generation_jobs_run_idx` ON `xiaoluo_v2_generation_jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `intent_conversations_workspace_idx` ON `xiaoluo_v2_intent_conversations` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `intent_conversations_canvas_idx` ON `xiaoluo_v2_intent_conversations` (`canvas_id`);--> statement-breakpoint
CREATE INDEX `intent_messages_conversation_idx` ON `xiaoluo_v2_intent_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `run_events_run_created_idx` ON `xiaoluo_v2_run_events` (`run_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD CONSTRAINT `xiaoluo_v2_kernel_runs_workspace_id_xiaoluo_v2_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD CONSTRAINT `xiaoluo_v2_kernel_runs_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_runs` ADD CONSTRAINT `xiaoluo_v2_kernel_runs_canvas_id_xiaoluo_v2_canvases_id_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD CONSTRAINT `fk_model_connections_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD CONSTRAINT `xiaoluo_v2_model_connections_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_model_connections` ADD CONSTRAINT `fk_model_connections_secret` FOREIGN KEY (`secret_ref_id`) REFERENCES `xiaoluo_v2_secret_refs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD CONSTRAINT `xiaoluo_v2_packages_workspace_id_xiaoluo_v2_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD CONSTRAINT `xiaoluo_v2_packages_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_registry_events` ADD CONSTRAINT `fk_registry_events_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_registry_events` ADD CONSTRAINT `xiaoluo_v2_registry_events_actor_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;
