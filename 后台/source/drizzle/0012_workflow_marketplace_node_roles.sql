ALTER TABLE `xiaoluo_v2_canvas_nodes` ADD `node_role` enum('material','plugin','execution','result') NOT NULL DEFAULT 'execution';--> statement-breakpoint
UPDATE `xiaoluo_v2_canvas_nodes`
SET `node_role` = CASE
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`parameters_json`, '$.nodeRole')) IN ('material', 'plugin', 'execution', 'result')
    THEN JSON_UNQUOTE(JSON_EXTRACT(`parameters_json`, '$.nodeRole'))
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`parameters_json`, '$.source')) = 'asset-kernel'
    THEN 'material'
  WHEN JSON_EXTRACT(`parameters_json`, '$.resultSlot') = TRUE
    THEN 'result'
  WHEN JSON_EXTRACT(`parameters_json`, '$.packageId') IS NOT NULL
    AND JSON_EXTRACT(`parameters_json`, '$.runtimeType') IS NOT NULL
    THEN 'plugin'
  ELSE 'execution'
END;--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_workflow_listings` (
  `id` varchar(120) NOT NULL,
  `workflow_key` varchar(180) NOT NULL,
  `owner_workspace_id` varchar(36) NOT NULL,
  `author_user_id` varchar(36) NOT NULL,
  `source_canvas_id` varchar(36),
  `title` varchar(180) NOT NULL,
  `description` text NOT NULL,
  `category` varchar(80) NOT NULL DEFAULT '通用',
  `tags_json` longtext NOT NULL,
  `visibility` enum('private','workspace','link','public') NOT NULL DEFAULT 'private',
  `status` enum('draft','published','unlisted','archived') NOT NULL DEFAULT 'draft',
  `latest_version` int unsigned NOT NULL DEFAULT 1,
  `install_count` int unsigned NOT NULL DEFAULT 0,
  `share_token_hash` varchar(64),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `xiaoluo_v2_workflow_listings_pk` PRIMARY KEY (`id`),
  CONSTRAINT `workflow_listings_key_unique` UNIQUE (`workflow_key`),
  CONSTRAINT `workflow_listings_share_token_unique` UNIQUE (`share_token_hash`),
  CONSTRAINT `workflow_listings_workspace_fk` FOREIGN KEY (`owner_workspace_id`) REFERENCES `xiaoluo_v2_workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workflow_listings_author_fk` FOREIGN KEY (`author_user_id`) REFERENCES `xiaoluo_v2_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `workflow_listings_canvas_fk` FOREIGN KEY (`source_canvas_id`) REFERENCES `xiaoluo_v2_canvases` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;--> statement-breakpoint
CREATE INDEX `workflow_listings_marketplace_idx` ON `xiaoluo_v2_workflow_listings` (`status`,`visibility`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_listings_workspace_idx` ON `xiaoluo_v2_workflow_listings` (`owner_workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_listings_author_idx` ON `xiaoluo_v2_workflow_listings` (`author_user_id`);--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_workflow_versions` (
  `id` varchar(120) NOT NULL,
  `listing_id` varchar(120) NOT NULL,
  `version` int unsigned NOT NULL,
  `graph_json` longtext NOT NULL,
  `requirements_json` longtext NOT NULL,
  `manifest_json` longtext NOT NULL,
  `changelog` text NOT NULL,
  `integrity_sha256` varchar(64) NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `xiaoluo_v2_workflow_versions_pk` PRIMARY KEY (`id`),
  CONSTRAINT `workflow_versions_listing_version_unique` UNIQUE (`listing_id`,`version`),
  CONSTRAINT `workflow_versions_listing_fk` FOREIGN KEY (`listing_id`) REFERENCES `xiaoluo_v2_workflow_listings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workflow_versions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;--> statement-breakpoint
CREATE INDEX `workflow_versions_listing_idx` ON `xiaoluo_v2_workflow_versions` (`listing_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_workflow_installations` (
  `id` varchar(120) NOT NULL,
  `listing_id` varchar(120) NOT NULL,
  `version_id` varchar(120) NOT NULL,
  `workspace_id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `canvas_id` varchar(36) NOT NULL,
  `installed_by` varchar(36) NOT NULL,
  `installed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `xiaoluo_v2_workflow_installations_pk` PRIMARY KEY (`id`),
  CONSTRAINT `workflow_installations_listing_fk` FOREIGN KEY (`listing_id`) REFERENCES `xiaoluo_v2_workflow_listings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workflow_installations_version_fk` FOREIGN KEY (`version_id`) REFERENCES `xiaoluo_v2_workflow_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `workflow_installations_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workflow_installations_project_fk` FOREIGN KEY (`project_id`) REFERENCES `xiaoluo_v2_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workflow_installations_canvas_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workflow_installations_user_fk` FOREIGN KEY (`installed_by`) REFERENCES `xiaoluo_v2_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;--> statement-breakpoint
CREATE INDEX `workflow_installations_listing_idx` ON `xiaoluo_v2_workflow_installations` (`listing_id`,`installed_at`);--> statement-breakpoint
CREATE INDEX `workflow_installations_workspace_idx` ON `xiaoluo_v2_workflow_installations` (`workspace_id`,`installed_at`);
