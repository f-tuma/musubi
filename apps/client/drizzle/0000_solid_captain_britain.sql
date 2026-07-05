CREATE TABLE `notifications_table` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identifier` text NOT NULL,
	`eventID` text NOT NULL,
	`triggerDate` text NOT NULL
);
