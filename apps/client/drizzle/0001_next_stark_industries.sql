CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`creatorID` text NOT NULL,
	`title` text NOT NULL,
	`color` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`isAllDay` integer DEFAULT false NOT NULL,
	`description` text,
	`location` text,
	`isCanceled` integer DEFAULT false NOT NULL,
	`organizer` text NOT NULL,
	`recurrence` text,
	`url` text,
	`calendars` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications_table` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identifier` text NOT NULL,
	`eventID` text NOT NULL,
	`triggerDate` text
);
--> statement-breakpoint
INSERT INTO `__new_notifications_table`("id", "identifier", "eventID", "triggerDate") SELECT "id", "identifier", "eventID", "triggerDate" FROM `notifications_table`;--> statement-breakpoint
DROP TABLE `notifications_table`;--> statement-breakpoint
ALTER TABLE `__new_notifications_table` RENAME TO `notifications_table`;--> statement-breakpoint
PRAGMA foreign_keys=ON;