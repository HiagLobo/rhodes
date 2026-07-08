CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ator_id` integer,
	`ator_login` text,
	`acao` text NOT NULL,
	`entidade` text,
	`entidade_id` text,
	`antes` text,
	`depois` text,
	`ip` text,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log` BEGIN
	SELECT RAISE(ABORT, 'audit_log é append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log` BEGIN
	SELECT RAISE(ABORT, 'audit_log é append-only');
END;
