CREATE TABLE `task_instances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer NOT NULL,
	`due_date` text NOT NULL,
	`window_end` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`origin` text DEFAULT 'CALENDAR' NOT NULL,
	`round_id` integer,
	`executante_id` integer,
	`started_at` integer,
	`finished_at` integer,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `task_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`executante_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_instances_aberta_por_template_uq` ON `task_instances` (`template_id`) WHERE status IN ('PENDING','IN_PROGRESS','OVERDUE');--> statement-breakpoint
CREATE INDEX `task_instances_status_idx` ON `task_instances` (`status`);--> statement-breakpoint
CREATE INDEX `task_instances_due_idx` ON `task_instances` (`due_date`);--> statement-breakpoint
ALTER TABLE `task_templates` ADD `fixed_dow` integer;