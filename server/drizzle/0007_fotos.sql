CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`tipo` text NOT NULL,
	`parte` integer DEFAULT 1 NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`tamanho_bytes` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	`skew_ms` integer NOT NULL,
	`exif_datetime` text,
	`exif_model` text,
	`enviado_por_id` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `task_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enviado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_sha256_uq` ON `photos` (`sha256`);--> statement-breakpoint
CREATE INDEX `photos_instance_idx` ON `photos` (`instance_id`);