CREATE TABLE "provider_budget_cooldowns" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"dimension" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_budget_cooldowns_dimension_check" CHECK ("provider_budget_cooldowns"."dimension" in ('provider','application','tenant','account')),
	CONSTRAINT "provider_budget_cooldowns_scope_check" CHECK ("provider_budget_cooldowns"."scope_key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sync_read_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"oauth_account_id" text,
	"caldav_account_id" uuid,
	"source_id" uuid,
	"scope_key" text NOT NULL,
	"stream" text NOT NULL,
	"oauth_read_generation" integer,
	"oauth_scope" text,
	"caldav_credential_revision" text,
	"caldav_credential_fingerprint" text,
	"source_generation" integer,
	"provider_access_revision" integer,
	"source_configuration_fingerprint" text,
	"source_fingerprint" text,
	"configuration_fingerprint" text NOT NULL,
	"policy_fingerprint" text NOT NULL,
	"binding_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"requested_generation" bigint DEFAULT 1 NOT NULL,
	"completed_generation" bigint DEFAULT 0 NOT NULL,
	"claim_generation" bigint,
	"claim_token" uuid,
	"lease_until" timestamp with time zone,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"last_deferral_kind" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_read_work_provider_check" CHECK ("sync_read_work"."provider" in ('google','microsoft','caldav')),
	CONSTRAINT "sync_read_work_connection_check" CHECK ((
    ("sync_read_work"."provider" in ('google','microsoft') and "sync_read_work"."oauth_account_id" is not null and "sync_read_work"."caldav_account_id" is null and "sync_read_work"."oauth_read_generation" is not null and "sync_read_work"."oauth_read_generation" >= 0 and "sync_read_work"."caldav_credential_revision" is null and "sync_read_work"."caldav_credential_fingerprint" is null)
    or ("sync_read_work"."provider" = 'caldav' and "sync_read_work"."oauth_account_id" is null and "sync_read_work"."caldav_account_id" is not null and "sync_read_work"."oauth_read_generation" is null and "sync_read_work"."oauth_scope" is null and "sync_read_work"."caldav_credential_revision" is not null and "sync_read_work"."caldav_credential_fingerprint" is not null))),
	CONSTRAINT "sync_read_work_stream_check" CHECK ((
    ("sync_read_work"."source_id" is null and "sync_read_work"."scope_key" = 'account' and "sync_read_work"."stream" = 'discovery' and "sync_read_work"."source_generation" is null and "sync_read_work"."provider_access_revision" is null and "sync_read_work"."source_configuration_fingerprint" is null and "sync_read_work"."source_fingerprint" is null)
    or ("sync_read_work"."source_id" is not null and "sync_read_work"."scope_key" = "sync_read_work"."source_id"::text and "sync_read_work"."stream" in ('events','tasks','components') and "sync_read_work"."source_generation" is not null and "sync_read_work"."source_generation" >= 0 and "sync_read_work"."provider_access_revision" is not null and "sync_read_work"."provider_access_revision" >= 0 and "sync_read_work"."source_fingerprint" is not null))),
	CONSTRAINT "sync_read_work_generations_check" CHECK ("sync_read_work"."completed_generation" >= 0 and "sync_read_work"."requested_generation" >= "sync_read_work"."completed_generation"),
	CONSTRAINT "sync_read_work_deferral_check" CHECK ("sync_read_work"."last_deferral_kind" is null or "sync_read_work"."last_deferral_kind" in ('optional-unavailable','budget','failure')),
	CONSTRAINT "sync_read_work_retirement_check" CHECK ("sync_read_work"."retired_at" is null or ("sync_read_work"."claim_token" is null and "sync_read_work"."claim_generation" is null and "sync_read_work"."lease_until" is null)),
	CONSTRAINT "sync_read_work_claim_check" CHECK ((
    ("sync_read_work"."claim_token" is null and "sync_read_work"."claim_generation" is null and "sync_read_work"."lease_until" is null)
    or ("sync_read_work"."claim_token" is not null and "sync_read_work"."claim_generation" is not null and "sync_read_work"."lease_until" is not null and "sync_read_work"."claim_generation" > "sync_read_work"."completed_generation" and "sync_read_work"."claim_generation" <= "sync_read_work"."requested_generation")))
);
--> statement-breakpoint
ALTER TABLE "outlook_moves" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_read_work" ADD CONSTRAINT "sync_read_work_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_read_work" ADD CONSTRAINT "sync_read_work_oauth_account_id_account_id_fk" FOREIGN KEY ("oauth_account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_read_work" ADD CONSTRAINT "sync_read_work_caldav_account_id_caldav_accounts_id_fk" FOREIGN KEY ("caldav_account_id") REFERENCES "public"."caldav_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_read_work" ADD CONSTRAINT "sync_read_work_source_id_external_calendars_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_budget_cooldowns_expiry_idx" ON "provider_budget_cooldowns" USING btree ("not_before");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_read_work_oauth_scope_idx" ON "sync_read_work" USING btree ("oauth_account_id","scope_key","stream") WHERE "sync_read_work"."oauth_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_read_work_caldav_scope_idx" ON "sync_read_work" USING btree ("caldav_account_id","scope_key","stream") WHERE "sync_read_work"."caldav_account_id" is not null;--> statement-breakpoint
CREATE INDEX "sync_read_work_source_idx" ON "sync_read_work" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sync_read_work_user_idx" ON "sync_read_work" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_read_work_due_idx" ON "sync_read_work" USING btree ("not_before","last_started_at","id") WHERE "sync_read_work"."retired_at" is null and "sync_read_work"."requested_generation" > "sync_read_work"."completed_generation";--> statement-breakpoint
CREATE INDEX "outlook_moves_due_idx" ON "outlook_moves" USING btree ("next_attempt_at","updated_at","id") WHERE "outlook_moves"."status" = 'running';