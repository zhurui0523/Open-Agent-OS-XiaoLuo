ALTER TABLE `xiaoluo_v2_organization_invitations`
  MODIFY COLUMN `phone_hash` varchar(64) NULL,
  MODIFY COLUMN `phone_last4` varchar(4) NULL;--> statement-breakpoint

ALTER TABLE `xiaoluo_v2_organization_invitations`
  ADD `invitee_user_id` varchar(36) NULL AFTER `organization_id`;--> statement-breakpoint

ALTER TABLE `xiaoluo_v2_organization_invitations`
  ADD `declined_at` datetime(3) NULL AFTER `accepted_at`;--> statement-breakpoint

UPDATE `xiaoluo_v2_organization_invitations` invitation
INNER JOIN `xiaoluo_v2_users` invitee
  ON invitee.`phone_hash` = invitation.`phone_hash`
SET invitation.`invitee_user_id` = invitee.`id`
WHERE invitation.`invitee_user_id` IS NULL;--> statement-breakpoint

CREATE INDEX `organization_invitations_invitee_idx`
  ON `xiaoluo_v2_organization_invitations` (`invitee_user_id`);--> statement-breakpoint

ALTER TABLE `xiaoluo_v2_organization_invitations`
  ADD CONSTRAINT `fk_org_invites_invitee`
  FOREIGN KEY (`invitee_user_id`)
  REFERENCES `xiaoluo_v2_users` (`id`)
  ON DELETE CASCADE;
