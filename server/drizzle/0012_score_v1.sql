CREATE TABLE `demeritos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`inspection_id` integer NOT NULL,
	`area_id` integer NOT NULL,
	`severidade` text NOT NULL,
	`confirmado_por_id` integer NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`inspection_id`) REFERENCES `inspections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demeritos_inspection_id_unique` ON `demeritos` (`inspection_id`);--> statement-breakpoint
CREATE TABLE `external_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`orgao` text NOT NULL,
	`data_inspecao` text NOT NULL,
	`nota` real NOT NULL,
	`observacao` text,
	`criado_por_id` integer NOT NULL,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`criado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `external_audit_achados` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`audit_id` integer NOT NULL,
	`area_id` integer,
	`severidade` text NOT NULL,
	`descricao` text NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `external_audit`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `demeritos_no_update` BEFORE UPDATE ON `demeritos` BEGIN
	SELECT RAISE(ABORT, 'demeritos é append-only — o demérito confirmado não se reescreve (ALCOA+)');
END;
--> statement-breakpoint
CREATE TRIGGER `demeritos_no_delete` BEFORE DELETE ON `demeritos` BEGIN
	SELECT RAISE(ABORT, 'demeritos é append-only — o demérito confirmado não se apaga (ALCOA+)');
END;
--> statement-breakpoint
CREATE TRIGGER `external_audit_no_update` BEFORE UPDATE ON `external_audit` BEGIN
	SELECT RAISE(ABORT, 'external_audit é append-only — a nota externa não se reescreve (ALCOA+)');
END;
--> statement-breakpoint
CREATE TRIGGER `external_audit_no_delete` BEFORE DELETE ON `external_audit` BEGIN
	SELECT RAISE(ABORT, 'external_audit é append-only — a nota externa não se apaga (ALCOA+)');
END;
--> statement-breakpoint
CREATE TRIGGER `external_audit_achados_no_update` BEFORE UPDATE ON `external_audit_achados` BEGIN
	SELECT RAISE(ABORT, 'external_audit_achados é append-only (ALCOA+)');
END;
--> statement-breakpoint
CREATE TRIGGER `external_audit_achados_no_delete` BEFORE DELETE ON `external_audit_achados` BEGIN
	SELECT RAISE(ABORT, 'external_audit_achados é append-only (ALCOA+)');
END;
