DROP INDEX `generation_jobs_due_idx` ON `xiaoluo_v2_generation_jobs`;
ALTER TABLE `xiaoluo_v2_generation_jobs` DROP COLUMN `lease_expires_at`;
ALTER TABLE `xiaoluo_v2_generation_jobs` DROP COLUMN `lease_owner`;
