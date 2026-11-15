CREATE TABLE `xiaoluo_v2_canvas_share_links` (
	`id` varchar(120) NOT NULL,
	`canvas_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`mode` enum('read_only','workflow') NOT NULL,
	`graph_json` longtext NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`expires_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_canvas_share_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `xiaoluo_v2_canvas_share_links_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `xiaoluo_v2_rate_limit_buckets` (
	`id` varchar(64) NOT NULL,
	`subject` varchar(160) NOT NULL,
	`route` varchar(160) NOT NULL,
	`window_started_at` datetime(3) NOT NULL,
	`count` int unsigned NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `xiaoluo_v2_rate_limit_buckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_edges` ADD `source_port_id` varchar(80) DEFAULT 'output' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_edges` ADD `target_port_id` varchar(80) DEFAULT 'input' NOT NULL;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_edges` ADD `data_type` varchar(24) DEFAULT 'text' NOT NULL;--> statement-breakpoint
UPDATE `xiaoluo_v2_canvas_edges` AS `edge`
INNER JOIN `xiaoluo_v2_canvas_nodes` AS `source_node`
  ON `source_node`.`canvas_id` = `edge`.`canvas_id`
 AND `source_node`.`id` = `edge`.`source_node_id`
INNER JOIN `xiaoluo_v2_canvas_nodes` AS `target_node`
  ON `target_node`.`canvas_id` = `edge`.`canvas_id`
 AND `target_node`.`id` = `edge`.`target_node_id`
SET
  `edge`.`source_port_id` = CASE `source_node`.`kind`
    WHEN 'image' THEN 'image'
    WHEN 'video' THEN 'video'
    ELSE 'text'
  END,
  `edge`.`data_type` = CASE `source_node`.`kind`
    WHEN 'image' THEN 'image'
    WHEN 'video' THEN 'video'
    ELSE 'text'
  END,
  `edge`.`target_port_id` = CASE
    WHEN `target_node`.`kind` = 'text' THEN 'context'
    WHEN `source_node`.`kind` = 'text' THEN 'prompt'
    ELSE 'reference'
  END;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_share_links` ADD CONSTRAINT `canvas_share_canvas_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_canvas_share_links` ADD CONSTRAINT `canvas_share_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `canvas_share_canvas_idx` ON `xiaoluo_v2_canvas_share_links` (`canvas_id`);--> statement-breakpoint
CREATE INDEX `canvas_share_expiry_idx` ON `xiaoluo_v2_canvas_share_links` (`expires_at`);--> statement-breakpoint
CREATE INDEX `rate_limit_subject_route_idx` ON `xiaoluo_v2_rate_limit_buckets` (`subject`,`route`);--> statement-breakpoint
CREATE INDEX `rate_limit_updated_idx` ON `xiaoluo_v2_rate_limit_buckets` (`updated_at`);
