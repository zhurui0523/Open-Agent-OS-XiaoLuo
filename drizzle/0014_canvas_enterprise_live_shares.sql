CREATE TABLE `xiaoluo_v2_canvas_enterprise_shares` (
  `canvas_id` varchar(36) NOT NULL,
  `source_canvas_id` varchar(36),
  `organization_id` varchar(36) NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `canvas_enterprise_shares_pk` PRIMARY KEY (`canvas_id`,`organization_id`),
  CONSTRAINT `canvas_enterprise_shares_canvas_fk` FOREIGN KEY (`canvas_id`) REFERENCES `xiaoluo_v2_canvases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `canvas_enterprise_shares_source_canvas_fk` FOREIGN KEY (`source_canvas_id`) REFERENCES `xiaoluo_v2_canvases` (`id`) ON DELETE SET NULL,
  CONSTRAINT `canvas_enterprise_shares_org_fk` FOREIGN KEY (`organization_id`) REFERENCES `xiaoluo_v2_organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `canvas_enterprise_shares_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `xiaoluo_v2_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;--> statement-breakpoint
CREATE INDEX `canvas_enterprise_shares_org_idx` ON `xiaoluo_v2_canvas_enterprise_shares` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_enterprise_shares_source_org_unique` ON `xiaoluo_v2_canvas_enterprise_shares` (`source_canvas_id`,`organization_id`);
