CREATE TABLE `areas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nome` text NOT NULL,
	`peso_criticidade` real DEFAULT 1 NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `areas_nome_unique` ON `areas` (`nome`);--> statement-breakpoint
CREATE TABLE `metodo_versoes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer NOT NULL,
	`versao` integer NOT NULL,
	`texto` text NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	`criado_por_id` integer,
	FOREIGN KEY (`template_id`) REFERENCES `task_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`criado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metodo_versoes_template_versao_uq` ON `metodo_versoes` (`template_id`,`versao`);--> statement-breakpoint
CREATE TABLE `score_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`valores` text NOT NULL,
	`motivo` text,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	`criado_por_id` integer,
	FOREIGN KEY (`criado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`area_id` integer NOT NULL,
	`atividade` text NOT NULL,
	`frequency` text NOT NULL,
	`interval_days` integer NOT NULL,
	`schedule_mode` text NOT NULL,
	`grace_days` integer NOT NULL,
	`trigger_type` text DEFAULT 'CALENDAR' NOT NULL,
	`ship_phase` text,
	`lead_days` integer,
	`limitacoes` text,
	`depends_on_template_id` integer,
	`metodo_versao_atual_id` integer,
	`ativo` integer DEFAULT true NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_template_id`) REFERENCES `task_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`metodo_versao_atual_id`) REFERENCES `metodo_versoes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `score_config_no_update` BEFORE UPDATE ON `score_config` BEGIN
	SELECT RAISE(ABORT, 'score_config é versionada — mudar parâmetro é inserir uma nova linha');
END;
--> statement-breakpoint
CREATE TRIGGER `score_config_no_delete` BEFORE DELETE ON `score_config` BEGIN
	SELECT RAISE(ABORT, 'score_config é versionada — mudar parâmetro é inserir uma nova linha');
END;
