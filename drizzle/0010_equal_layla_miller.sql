ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `lease_owner` varchar(160);--> statement-breakpoint
ALTER TABLE `xiaoluo_v2_generation_jobs` ADD `lease_expires_at` datetime(3);--> statement-breakpoint
CREATE INDEX `generation_jobs_due_idx` ON `xiaoluo_v2_generation_jobs` (`status`,`next_poll_at`,`lease_expires_at`);