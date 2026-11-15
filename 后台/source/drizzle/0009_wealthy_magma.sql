CREATE TABLE `xiaoluo_v2_canvas_collaboration_events` (
	`sequence` bigint unsigned AUTO_INCREMENT NOT NULL,
	`id` varchar(120) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`session_id` varchar(80),
	`event_type` varchar(80) NOT NULL,
	`payload_json` longtext NOT NULL,
	`canvas_revision` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_canvas_collaboration_events_sequence` PRIMARY KEY(`sequence`),
	CONSTRAINT `xiaoluo_v2_canvas_collaboration_events_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_canvas_comments` (
	`id` varchar(120) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`node_id` varchar(120),
	`author_user_id` varchar(36) NOT NULL,
	`content` text NOT NULL,
	`mentions_json` longtext NOT NULL,
	`status` enum('open','resolved') NOT NULL DEFAULT 'open',
	`resolved_by` varchar(36),
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_canvas_comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_canvas_presence` (
	`canvas_id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`session_id` varchar(80) NOT NULL,
	`cursor_x` double,
	`cursor_y` double,
	`selected_node_ids_json` longtext NOT NULL,
	`client_revision` bigint unsigned NOT NULL DEFAULT 0,
	`state` varchar(24) NOT NULL DEFAULT 'active',
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `canvas_presence_pk` PRIMARY KEY(`canvas_id`,`user_id`,`session_id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_isolated_worker_jobs` (
	`id` varchar(120) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`requested_by` varchar(36) NOT NULL,
	`package_id` varchar(120),
	`runtime` enum('node','python','cli') NOT NULL,
	`status` enum('queued','dispatched','running','succeeded','failed','canceled') NOT NULL DEFAULT 'queued',
	`endpoint_origin` varchar(300),
	`external_execution_id` varchar(240),
	`request_json` longtext NOT NULL,
	`response_json` longtext,
	`policy_json` longtext NOT NULL,
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_isolated_worker_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_package_reviews` (
	`id` varchar(120) NOT NULL,
	`package_key` varchar(160) NOT NULL,
	`version` varchar(80) NOT NULL,
	`publisher_id` varchar(120),
	`publisher_key_id` varchar(120),
	`manifest_sha256` varchar(64) NOT NULL,
	`signature` text,
	`signature_verified` boolean NOT NULL DEFAULT false,
	`status` enum('pending','approved','rejected','quarantined','revoked') NOT NULL DEFAULT 'pending',
	`scan_json` longtext NOT NULL,
	`reason` text,
	`submitted_by` varchar(36) NOT NULL,
	`reviewed_by` varchar(36),
	`reviewed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_package_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `package_reviews_package_version_unique` UNIQUE(`package_key`,`version`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_publisher_keys` (
	`id` varchar(120) NOT NULL,
	`publisher_id` varchar(120) NOT NULL,
	`algorithm` varchar(40) NOT NULL DEFAULT 'ECDSA_P256_SHA256',
	`public_key_pem` longtext NOT NULL,
	`fingerprint_sha256` varchar(64) NOT NULL,
	`status` enum('active','revoked','expired') NOT NULL DEFAULT 'active',
	`expires_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_publisher_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_publisher_keys_fingerprint_sha256_unique` UNIQUE(`fingerprint_sha256`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_system_heartbeats` (
	`component` varchar(80) NOT NULL,
	`instance_id` varchar(160) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'healthy',
	`detail_json` longtext NOT NULL,
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_system_heartbeats_component` PRIMARY KEY(`component`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_trusted_publishers` (
	`id` varchar(120) NOT NULL,
	`slug` varchar(160) NOT NULL,
	`display_name` varchar(180) NOT NULL,
	`website` text,
	`contact_email` varchar(254),
	`status` enum('pending','approved','suspended','revoked') NOT NULL DEFAULT 'pending',
	`created_by` varchar(36) NOT NULL,
	`reviewed_by` varchar(36),
	`reviewed_at` datetime(3),
	`reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_trusted_publishers_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_trusted_publishers_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `publisher_id` varchar(120);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `review_id` varchar(120);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD `trust_state` varchar(32) DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_packages` SET `trust_state` = 'reviewed' WHERE `trust_state` = 'unverified';--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_collaboration_events` ADD CONSTRAINT `canvas_collaboration_canvas_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_collaboration_events` ADD CONSTRAINT `canvas_collaboration_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_collaboration_events` ADD CONSTRAINT `canvas_collaboration_actor_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_comments` ADD CONSTRAINT `canvas_comments_canvas_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_comments` ADD CONSTRAINT `canvas_comments_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_comments` ADD CONSTRAINT `canvas_comments_author_fk` FOREIGN KEY (`author_user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_comments` ADD CONSTRAINT `canvas_comments_resolver_fk` FOREIGN KEY (`resolved_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_presence` ADD CONSTRAINT `canvas_presence_canvas_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_presence` ADD CONSTRAINT `canvas_presence_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_presence` ADD CONSTRAINT `canvas_presence_user_fk` FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_isolated_worker_jobs` ADD CONSTRAINT `isolated_jobs_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_isolated_worker_jobs` ADD CONSTRAINT `isolated_jobs_requester_fk` FOREIGN KEY (`requested_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_isolated_worker_jobs` ADD CONSTRAINT `isolated_jobs_package_fk` FOREIGN KEY (`package_id`) REFERENCES `xiaoluo_v2_packages`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_reviews` ADD CONSTRAINT `package_reviews_publisher_fk` FOREIGN KEY (`publisher_id`) REFERENCES `xiaoluo_v2_trusted_publishers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_reviews` ADD CONSTRAINT `package_reviews_publisher_key_fk` FOREIGN KEY (`publisher_key_id`) REFERENCES `xiaoluo_v2_publisher_keys`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_reviews` ADD CONSTRAINT `package_reviews_submitter_fk` FOREIGN KEY (`submitted_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_package_reviews` ADD CONSTRAINT `package_reviews_reviewer_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_publisher_keys` ADD CONSTRAINT `publisher_keys_publisher_fk` FOREIGN KEY (`publisher_id`) REFERENCES `xiaoluo_v2_trusted_publishers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_trusted_publishers` ADD CONSTRAINT `trusted_publishers_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_trusted_publishers` ADD CONSTRAINT `trusted_publishers_reviewer_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `canvas_collab_canvas_sequence_idx` ON `xiaoluo_v2_canvas_collaboration_events` (`canvas_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `canvas_collab_actor_idx` ON `xiaoluo_v2_canvas_collaboration_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `canvas_comments_canvas_status_idx` ON `xiaoluo_v2_canvas_comments` (`canvas_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `canvas_comments_author_idx` ON `xiaoluo_v2_canvas_comments` (`author_user_id`);--> statement-breakpoint
CREATE INDEX `canvas_presence_canvas_seen_idx` ON `xiaoluo_v2_canvas_presence` (`canvas_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `canvas_presence_user_idx` ON `xiaoluo_v2_canvas_presence` (`user_id`);--> statement-breakpoint
CREATE INDEX `isolated_jobs_workspace_status_idx` ON `xiaoluo_v2_isolated_worker_jobs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `isolated_jobs_external_idx` ON `xiaoluo_v2_isolated_worker_jobs` (`external_execution_id`);--> statement-breakpoint
CREATE INDEX `package_reviews_status_idx` ON `xiaoluo_v2_package_reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `package_reviews_publisher_idx` ON `xiaoluo_v2_package_reviews` (`publisher_id`);--> statement-breakpoint
CREATE INDEX `publisher_keys_publisher_status_idx` ON `xiaoluo_v2_publisher_keys` (`publisher_id`,`status`);--> statement-breakpoint
CREATE INDEX `system_heartbeats_seen_idx` ON `xiaoluo_v2_system_heartbeats` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `trusted_publishers_status_idx` ON `xiaoluo_v2_trusted_publishers` (`status`);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD CONSTRAINT `packages_publisher_fk` FOREIGN KEY (`publisher_id`) REFERENCES `xiaoluo_v2_trusted_publishers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_packages` ADD CONSTRAINT `packages_review_fk` FOREIGN KEY (`review_id`) REFERENCES `xiaoluo_v2_package_reviews`(`id`) ON DELETE set null ON UPDATE no action;
