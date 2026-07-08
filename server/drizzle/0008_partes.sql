CREATE TABLE `execucao_partes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`parte` integer NOT NULL,
	`percentual_acumulado` integer NOT NULL,
	`observacao` text,
	`executante_id` integer NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `task_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`executante_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execucao_partes_instance_parte_uq` ON `execucao_partes` (`instance_id`,`parte`);--> statement-breakpoint
ALTER TABLE `task_templates` ADD `min_fotos_intervalo_min` integer DEFAULT 5 NOT NULL;