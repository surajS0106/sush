CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` date,
	`refreshTokenExpiresAt` date,
	`scope` text,
	`password` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` date NOT NULL,
	`token` text NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `share` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`metrics` integer DEFAULT 0 NOT NULL,
	`metrics_done` integer DEFAULT 0 NOT NULL,
	`e2e` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `share_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role_cap` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`max_uses` integer NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`share_id`) REFERENCES `share`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_invite_token_hash_unique` ON `share_invite` (`token_hash`);--> statement-breakpoint
CREATE TABLE `share_member` (
	`share_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_cap` text NOT NULL,
	`joined_at` integer NOT NULL,
	`admitted` integer DEFAULT 0 NOT NULL,
	`kicked_at` integer,
	PRIMARY KEY(`share_id`, `user_id`),
	FOREIGN KEY (`share_id`) REFERENCES `share`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `share_metric` (
	`week` text NOT NULL,
	`metric` text NOT NULL,
	`bucket` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`week`, `metric`, `bucket`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` date NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);