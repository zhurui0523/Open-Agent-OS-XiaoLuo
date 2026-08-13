CREATE TABLE `xiaoluo_v2_package_availabilities` (
  `id` varchar(120) NOT NULL,
  `package_id` varchar(120) NOT NULL,
  `workspace_id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `xiaoluo_v2_package_availabilities_id` PRIMARY KEY (`id`),
  CONSTRAINT `package_availabilities_package_workspace_user_unique`
    UNIQUE (`package_id`, `workspace_id`, `user_id`),
  CONSTRAINT `fk_package_availabilities_package`
    FOREIGN KEY (`package_id`) REFERENCES `xiaoluo_v2_packages` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_package_availabilities_workspace`
    FOREIGN KEY (`workspace_id`) REFERENCES `xiaoluo_v2_workspaces` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_package_availabilities_user`
    FOREIGN KEY (`user_id`) REFERENCES `xiaoluo_v2_users` (`id`)
    ON DELETE CASCADE,
  INDEX `package_availabilities_workspace_user_idx`
    (`workspace_id`, `user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
