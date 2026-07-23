CREATE TABLE `model_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`model_name` text NOT NULL,
	`modalities_json` text NOT NULL,
	`credential_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`state` text DEFAULT 'attention' NOT NULL,
	`latency_ms` integer,
	`last_checked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `package_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`modality` text NOT NULL,
	`contribution_type` text NOT NULL,
	`input_schema_json` text DEFAULT '{}' NOT NULL,
	`output_schema_json` text DEFAULT '{}' NOT NULL,
	`ui_schema_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`package_type` text NOT NULL,
	`runtime_type` text NOT NULL,
	`runtime_url` text,
	`manifest_json` text NOT NULL,
	`permissions_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`installed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
