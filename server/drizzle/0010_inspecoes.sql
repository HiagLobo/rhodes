CREATE TABLE `inspections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`resultado` text NOT NULL,
	`vistoriador_id` integer NOT NULL,
	`motivo` text,
	`severidade` text,
	`texto` text,
	`foto_id` integer,
	`amostral` integer DEFAULT false NOT NULL,
	`retrabalho_instance_id` integer,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `task_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vistoriador_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`foto_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retrabalho_instance_id`) REFERENCES `task_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inspections_instance_id_unique` ON `inspections` (`instance_id`);--> statement-breakpoint
ALTER TABLE `task_instances` ADD `rework_of_instance_id` integer REFERENCES task_instances(id);