CREATE TABLE `ship_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` integer NOT NULL,
	`transicao` text NOT NULL,
	`event_at` integer NOT NULL,
	`registered_at` integer DEFAULT (unixepoch()) NOT NULL,
	`registrado_por_id` integer NOT NULL,
	`confirmado_por_id` integer,
	FOREIGN KEY (`operation_id`) REFERENCES `ship_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`registrado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ship_events_operation_idx` ON `ship_events` (`operation_id`);--> statement-breakpoint
CREATE TABLE `ship_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`navio` text NOT NULL,
	`produto` text,
	`tonelagem` real,
	`eta_date` text NOT NULL,
	`status` text DEFAULT 'ANUNCIADO' NOT NULL,
	`criado_por_id` integer,
	`criado_em` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`criado_por_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
