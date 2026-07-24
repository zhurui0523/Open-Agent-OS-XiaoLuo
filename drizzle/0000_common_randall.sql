CREATE TABLE `xiaoluo_v2_asset_folders` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(180) NOT NULL,
	`parent_id` varchar(120),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_asset_folders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_asset_relations` (
	`id` varchar(120) NOT NULL,
	`from_asset_id` varchar(120) NOT NULL,
	`to_asset_id` varchar(120) NOT NULL,
	`relation_type` varchar(80) NOT NULL,
	`metadata_json` longtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_asset_relations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_asset_versions` (
	`id` varchar(120) NOT NULL,
	`asset_id` varchar(120) NOT NULL,
	`version` int unsigned NOT NULL,
	`blob_key` varchar(420) NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`mime_type` varchar(180) NOT NULL,
	`size` bigint unsigned NOT NULL,
	`source_type` varchar(80) NOT NULL DEFAULT 'upload',
	`source_ref` varchar(240),
	`metadata_json` longtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_asset_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `asset_versions_asset_version_unique` UNIQUE(`asset_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_assets` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`uri` varchar(240) NOT NULL,
	`name` varchar(240) NOT NULL,
	`kind` varchar(40) NOT NULL,
	`mime_type` varchar(180) NOT NULL,
	`size` bigint unsigned NOT NULL,
	`folder_id` varchar(120),
	`current_version_id` varchar(120),
	`current_version` int unsigned NOT NULL DEFAULT 1,
	`version_count` int unsigned NOT NULL DEFAULT 1,
	`tags_json` longtext NOT NULL,
	`description` text NOT NULL,
	`search_text` longtext NOT NULL,
	`source_type` varchar(80) NOT NULL DEFAULT 'upload',
	`source_ref` varchar(240),
	`content_hash` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'ready',
	`trashed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_assets_uri_unique` UNIQUE(`uri`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_auth_challenges` (
	`id` varchar(36) NOT NULL,
	`phone_hash` varchar(64) NOT NULL,
	`purpose` enum('register','password_reset','phone_change') NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`request_ip_hash` varchar(64) NOT NULL,
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 5,
	`expires_at` datetime(3) NOT NULL,
	`consumed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_auth_challenges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_auth_sessions` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_auth_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_auth_sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_canvas_edges` (
	`id` varchar(100) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`source_node_id` varchar(80) NOT NULL,
	`target_node_id` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_canvas_edges_canvas_id_id_pk` PRIMARY KEY(`canvas_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_canvas_nodes` (
	`id` varchar(80) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`kind` enum('text','image','video') NOT NULL,
	`title` varchar(240) NOT NULL,
	`prompt` text NOT NULL,
	`status` varchar(32) NOT NULL,
	`capability_id` varchar(120) NOT NULL,
	`model_id` varchar(120) NOT NULL,
	`x` double NOT NULL,
	`y` double NOT NULL,
	`progress` double,
	`result` longtext,
	`parameters_json` json NOT NULL,
	`client_created_at` bigint unsigned,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_canvas_nodes_canvas_id_id_pk` PRIMARY KEY(`canvas_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_canvases` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`title` varchar(180) NOT NULL,
	`revision` bigint unsigned NOT NULL DEFAULT 1,
	`arrange_mode` enum('free','time','type') NOT NULL DEFAULT 'free',
	`viewport_json` json NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `xiaoluo_v2_canvases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_enterprise_applications` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(36) NOT NULL,
	`applicant_id` varchar(36) NOT NULL,
	`contact_name` varchar(80) NOT NULL,
	`note` text NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reviewed_by` varchar(36),
	`reviewed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_enterprise_applications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_kernel_runs` (
	`id` varchar(120) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`graph_json` longtext NOT NULL,
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_kernel_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_kernel_tasks` (
	`id` varchar(160) NOT NULL,
	`run_id` varchar(120) NOT NULL,
	`node_id` varchar(120) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`dependencies_json` longtext NOT NULL,
	`input_json` longtext,
	`output_json` longtext,
	`executor` varchar(240),
	`error` text,
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_kernel_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_model_connections` (
	`id` varchar(120) NOT NULL,
	`name` varchar(180) NOT NULL,
	`protocol` varchar(60) NOT NULL,
	`base_url` text NOT NULL,
	`model_name` varchar(180) NOT NULL,
	`modalities_json` text NOT NULL,
	`credential_ref` varchar(80),
	`enabled` boolean NOT NULL DEFAULT true,
	`state` varchar(32) NOT NULL DEFAULT 'attention',
	`latency_ms` int,
	`last_checked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_model_connections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_organization_invitations` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(36) NOT NULL,
	`phone_hash` varchar(64) NOT NULL,
	`phone_last4` varchar(4) NOT NULL,
	`role` enum('admin','member') NOT NULL DEFAULT 'member',
	`token_hash` varchar(64) NOT NULL,
	`invited_by` varchar(36) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`accepted_by` varchar(36),
	`accepted_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_organization_invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_organization_invitations_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_organization_members` (
	`organization_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`role` enum('admin','member') NOT NULL DEFAULT 'member',
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_organization_members_organization_id_user_id_pk` PRIMARY KEY(`organization_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_organizations` (
	`id` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`registration_code` varchar(80),
	`status` enum('pending','active','rejected','disabled') NOT NULL DEFAULT 'pending',
	`workspace_id` varchar(36),
	`created_by` varchar(36) NOT NULL,
	`reviewed_by` varchar(36),
	`reviewed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_organizations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_package_capabilities` (
	`id` varchar(160) NOT NULL,
	`package_id` varchar(120) NOT NULL,
	`title` varchar(180) NOT NULL,
	`description` text NOT NULL,
	`modality` varchar(24) NOT NULL,
	`contribution_type` varchar(32) NOT NULL,
	`input_schema_json` longtext NOT NULL,
	`output_schema_json` longtext NOT NULL,
	`ui_schema_json` longtext NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `xiaoluo_v2_package_capabilities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_packages` (
	`id` varchar(120) NOT NULL,
	`name` varchar(180) NOT NULL,
	`version` varchar(80) NOT NULL,
	`description` text NOT NULL,
	`package_type` varchar(40) NOT NULL,
	`runtime_type` varchar(40) NOT NULL,
	`runtime_url` text,
	`manifest_json` longtext NOT NULL,
	`permissions_json` longtext NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`installed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_packages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_password_reset_tokens` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_password_reset_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_projects` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_registry_events` (
	`id` varchar(120) NOT NULL,
	`event_type` varchar(120) NOT NULL,
	`entity_id` varchar(160) NOT NULL,
	`detail_json` longtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_registry_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_resource_permissions` (
	`id` varchar(36) NOT NULL,
	`resource_type` enum('project','canvas','asset') NOT NULL,
	`resource_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`permission` enum('view','edit','manage') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_resource_permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `resource_permissions_unique` UNIQUE(`resource_type`,`resource_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(254) NOT NULL,
	`display_name` varchar(80) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`phone_hash` varchar(64),
	`phone_last4` varchar(4),
	`phone_verified_at` datetime(3),
	`platform_role` enum('system_admin','user') NOT NULL DEFAULT 'user',
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`password_changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_users_email_unique` UNIQUE(`email`),
	CONSTRAINT `xiaoluo_v2_users_phone_hash_unique` UNIQUE(`phone_hash`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_workspace_members` (
	`workspace_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`role` enum('owner','admin','editor','viewer') NOT NULL DEFAULT 'viewer',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_workspace_members_workspace_id_user_id_pk` PRIMARY KEY(`workspace_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_workspaces` (
	`id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_workspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_folders` ADD CONSTRAINT `fk_asset_folders_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_relations` ADD CONSTRAINT `xiaoluo_v2_asset_relations_from_asset_id_xiaoluo_v2_assets_id_fk` FOREIGN KEY (`from_asset_id`) REFERENCES `xiaoluo_v2_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_relations` ADD CONSTRAINT `xiaoluo_v2_asset_relations_to_asset_id_xiaoluo_v2_assets_id_fk` FOREIGN KEY (`to_asset_id`) REFERENCES `xiaoluo_v2_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_asset_versions` ADD CONSTRAINT `xiaoluo_v2_asset_versions_asset_id_xiaoluo_v2_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `xiaoluo_v2_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_assets` ADD CONSTRAINT `xiaoluo_v2_assets_workspace_id_xiaoluo_v2_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_auth_sessions` ADD CONSTRAINT `xiaoluo_v2_auth_sessions_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_edges` ADD CONSTRAINT `xiaoluo_v2_canvas_edges_canvas_id_xiaoluo_v2_canvases_id_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_nodes` ADD CONSTRAINT `xiaoluo_v2_canvas_nodes_canvas_id_xiaoluo_v2_canvases_id_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvases` ADD CONSTRAINT `xiaoluo_v2_canvases_project_id_xiaoluo_v2_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `xiaoluo_v2_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvases` ADD CONSTRAINT `xiaoluo_v2_canvases_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_enterprise_applications` ADD CONSTRAINT `fk_enterprise_apps_org` FOREIGN KEY (`organization_id`) REFERENCES `xiaoluo_v2_organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_enterprise_applications` ADD CONSTRAINT `fk_enterprise_apps_applicant` FOREIGN KEY (`applicant_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_enterprise_applications` ADD CONSTRAINT `fk_enterprise_apps_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_kernel_tasks` ADD CONSTRAINT `xiaoluo_v2_kernel_tasks_run_id_xiaoluo_v2_kernel_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `xiaoluo_v2_kernel_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organization_invitations` ADD CONSTRAINT `fk_org_invites_org` FOREIGN KEY (`organization_id`) REFERENCES `xiaoluo_v2_organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organization_invitations` ADD CONSTRAINT `fk_org_invites_inviter` FOREIGN KEY (`invited_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organization_invitations` ADD CONSTRAINT `fk_org_invites_accepter` FOREIGN KEY (`accepted_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organization_members` ADD CONSTRAINT `fk_org_members_org` FOREIGN KEY (`organization_id`) REFERENCES `xiaoluo_v2_organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organization_members` ADD CONSTRAINT `xiaoluo_v2_organization_members_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organizations` ADD CONSTRAINT `fk_orgs_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organizations` ADD CONSTRAINT `xiaoluo_v2_organizations_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_organizations` ADD CONSTRAINT `xiaoluo_v2_organizations_reviewed_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_capabilities` ADD CONSTRAINT `fk_package_caps_package` FOREIGN KEY (`package_id`) REFERENCES `xiaoluo_v2_packages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_password_reset_tokens` ADD CONSTRAINT `xiaoluo_v2_password_reset_tokens_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_projects` ADD CONSTRAINT `xiaoluo_v2_projects_workspace_id_xiaoluo_v2_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_projects` ADD CONSTRAINT `xiaoluo_v2_projects_created_by_xiaoluo_v2_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_resource_permissions` ADD CONSTRAINT `xiaoluo_v2_resource_permissions_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_workspace_members` ADD CONSTRAINT `fk_workspace_members_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_workspace_members` ADD CONSTRAINT `xiaoluo_v2_workspace_members_user_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_workspaces` ADD CONSTRAINT `xiaoluo_v2_workspaces_owner_id_xiaoluo_v2_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `asset_folders_workspace_idx` ON `xiaoluo_v2_asset_folders` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `asset_folders_parent_idx` ON `xiaoluo_v2_asset_folders` (`parent_id`);--> statement-breakpoint
CREATE INDEX `asset_relations_from_idx` ON `xiaoluo_v2_asset_relations` (`from_asset_id`);--> statement-breakpoint
CREATE INDEX `asset_relations_to_idx` ON `xiaoluo_v2_asset_relations` (`to_asset_id`);--> statement-breakpoint
CREATE INDEX `asset_versions_hash_idx` ON `xiaoluo_v2_asset_versions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `assets_workspace_idx` ON `xiaoluo_v2_assets` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `assets_folder_idx` ON `xiaoluo_v2_assets` (`folder_id`);--> statement-breakpoint
CREATE INDEX `assets_hash_idx` ON `xiaoluo_v2_assets` (`content_hash`);--> statement-breakpoint
CREATE INDEX `auth_challenges_phone_idx` ON `xiaoluo_v2_auth_challenges` (`phone_hash`,`purpose`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_challenges_ip_idx` ON `xiaoluo_v2_auth_challenges` (`request_ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_challenges_expiry_idx` ON `xiaoluo_v2_auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `xiaoluo_v2_auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `xiaoluo_v2_auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `canvas_edges_canvas_idx` ON `xiaoluo_v2_canvas_edges` (`canvas_id`);--> statement-breakpoint
CREATE INDEX `canvas_edges_source_idx` ON `xiaoluo_v2_canvas_edges` (`canvas_id`,`source_node_id`);--> statement-breakpoint
CREATE INDEX `canvas_edges_target_idx` ON `xiaoluo_v2_canvas_edges` (`canvas_id`,`target_node_id`);--> statement-breakpoint
CREATE INDEX `canvas_nodes_canvas_idx` ON `xiaoluo_v2_canvas_nodes` (`canvas_id`);--> statement-breakpoint
CREATE INDEX `canvases_project_idx` ON `xiaoluo_v2_canvases` (`project_id`);--> statement-breakpoint
CREATE INDEX `canvases_updated_idx` ON `xiaoluo_v2_canvases` (`updated_at`);--> statement-breakpoint
CREATE INDEX `enterprise_applications_status_idx` ON `xiaoluo_v2_enterprise_applications` (`status`);--> statement-breakpoint
CREATE INDEX `enterprise_applications_org_idx` ON `xiaoluo_v2_enterprise_applications` (`organization_id`);--> statement-breakpoint
CREATE INDEX `kernel_tasks_run_idx` ON `xiaoluo_v2_kernel_tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `organization_invitations_org_idx` ON `xiaoluo_v2_organization_invitations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `organization_invitations_phone_idx` ON `xiaoluo_v2_organization_invitations` (`phone_hash`);--> statement-breakpoint
CREATE INDEX `organization_invitations_expiry_idx` ON `xiaoluo_v2_organization_invitations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `organization_members_user_idx` ON `xiaoluo_v2_organization_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `organizations_status_idx` ON `xiaoluo_v2_organizations` (`status`);--> statement-breakpoint
CREATE INDEX `organizations_creator_idx` ON `xiaoluo_v2_organizations` (`created_by`);--> statement-breakpoint
CREATE INDEX `package_capabilities_package_idx` ON `xiaoluo_v2_package_capabilities` (`package_id`);--> statement-breakpoint
CREATE INDEX `password_reset_user_idx` ON `xiaoluo_v2_password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `password_reset_expiry_idx` ON `xiaoluo_v2_password_reset_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `xiaoluo_v2_projects` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `registry_events_created_idx` ON `xiaoluo_v2_registry_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `resource_permissions_lookup_idx` ON `xiaoluo_v2_resource_permissions` (`resource_type`,`resource_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `xiaoluo_v2_workspace_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `workspaces_owner_idx` ON `xiaoluo_v2_workspaces` (`owner_id`);
