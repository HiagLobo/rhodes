CREATE TABLE `justificativas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`motivo` text NOT NULL,
	`texto` text,
	`foto_id` integer,
	`status` text DEFAULT 'PENDENTE' NOT NULL,
	`criado_por_id` integer NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	`decidido_por_id` integer,
	`decidido_em` integer,
	`decisao_obs` text,
	FOREIGN KEY (`instance_id`) REFERENCES `task_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`foto_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`criado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decidido_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `justificativas_instance_id_unique` ON `justificativas` (`instance_id`);