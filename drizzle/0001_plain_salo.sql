CREATE TABLE `kernel_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`graph_json` text NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kernel_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`dependencies_json` text DEFAULT '[]' NOT NULL,
	`input_json` text,
	`output_json` text,
	`executor` text,
	`error` text,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `kernel_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
