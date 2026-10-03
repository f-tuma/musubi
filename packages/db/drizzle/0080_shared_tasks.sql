CREATE TABLE "calendar_tasks" (
	"task_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_tasks_task_id_calendar_id_pk" PRIMARY KEY("task_id","calendar_id")
);
--> statement-breakpoint
CREATE TABLE "task_mutations" (
	"actor_id" text NOT NULL,
	"mutation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_mutations_actor_id_mutation_id_pk" PRIMARY KEY("actor_id","mutation_id"),
	CONSTRAINT "task_mutations_revision_check" CHECK ("task_mutations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"mutation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"predecessor_id" uuid,
	"calendar_id" uuid NOT NULL,
	"external_calendar_link_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"external_calendar_id" text NOT NULL,
	"external_task_id" text,
	"expected_etag" text,
	"ical_uid" text,
	"provider_access_revision" integer NOT NULL,
	"retired_generation" integer DEFAULT 0 NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uncertain" boolean DEFAULT false NOT NULL,
	"result_ref" jsonb,
	"remote_snapshot" jsonb,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_outbox_mutation_position_unique" UNIQUE("actor_id","mutation_id","position"),
	CONSTRAINT "task_outbox_revision_check" CHECK ("task_outbox"."revision" > 0),
	CONSTRAINT "task_outbox_attempts_check" CHECK ("task_outbox"."attempts" >= 0 and "task_outbox"."position" >= 0),
	CONSTRAINT "task_outbox_action_check" CHECK ("task_outbox"."action" in ('create', 'update', 'delete')),
	CONSTRAINT "task_outbox_status_check" CHECK ("task_outbox"."status" in ('pending', 'attempting', 'completed', 'not-needed', 'conflict', 'not-written', 'unconfirmed', 'retry', 'blocked', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_calendar_id_calendars_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "calendar_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "external_tasks" ADD COLUMN "external_calendar_link_id" uuid;--> statement-breakpoint
ALTER TABLE "external_tasks" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "external_tasks" ADD COLUMN "provider_access_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_tasks" ADD COLUMN "projection_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "external_tasks" ADD COLUMN "accepted_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "origin_calendar_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_mutations" ADD CONSTRAINT "task_mutations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outbox" ADD CONSTRAINT "task_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_tasks_calendar_task_idx" ON "calendar_tasks" USING btree ("calendar_id","task_id");--> statement-breakpoint
CREATE INDEX "task_outbox_task_revision_idx" ON "task_outbox" USING btree ("task_id","revision");--> statement-breakpoint
CREATE INDEX "task_outbox_source_order_idx" ON "task_outbox" USING btree ("task_id","external_calendar_link_id","created_at");--> statement-breakpoint
CREATE INDEX "task_outbox_pending_idx" ON "task_outbox" USING btree ("next_attempt_at","id") WHERE "task_outbox"."status" in ('pending', 'retry', 'attempting', 'unconfirmed');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_origin_calendar_id_calendars_id_fk" FOREIGN KEY ("origin_calendar_id") REFERENCES "public"."calendars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_origin_updated_at_idx" ON "tasks" USING btree ("origin_calendar_id","updated_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_revision_check" CHECK ("tasks"."revision" > 0);
--> statement-breakpoint
-- Preserve UUIDs, provider identifiers/validators, SEQUENCE and tombstones.
-- Existing tasks never merge by UID/title/date; the old collection becomes home.
UPDATE "tasks" SET "origin_calendar_id" = "calendar_id";
--> statement-breakpoint
INSERT INTO "calendar_tasks" ("task_id", "calendar_id", "created_at")
SELECT "id", "calendar_id", "created_at" FROM "tasks" WHERE "calendar_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "external_tasks" mapping SET
  "external_calendar_link_id" = source."id",
  "account_id" = source."account_id",
  "provider_access_revision" = source."provider_access_revision"
FROM "external_calendars" source
WHERE source."calendar_id" = mapping."calendar_id"
  AND source."provider" = mapping."provider"
  AND source."external_calendar_id" = mapping."external_calendar_id";
