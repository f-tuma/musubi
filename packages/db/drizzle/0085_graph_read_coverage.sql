ALTER TABLE "external_calendars" ADD COLUMN "source_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_calendars" ADD COLUMN "checkpoint_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_calendars" ADD COLUMN "read_configuration_fingerprint" text;--> statement-breakpoint
ALTER TABLE "external_calendars" ADD COLUMN "read_coverage" jsonb;--> statement-breakpoint
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_source_generation_check" CHECK ("external_calendars"."source_generation" >= 0);--> statement-breakpoint
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_checkpoint_revision_check" CHECK ("external_calendars"."checkpoint_revision" >= 0);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "sync_read_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_sync_read_generation_check" CHECK ("account"."sync_read_generation" >= 0);
--> statement-breakpoint
-- Grant ABA can also originate in Better Auth's direct account writes. Only
-- the already locked account row is touched: no lifecycle/source lock inversion.
CREATE FUNCTION musubi_account_read_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_read_generation := OLD.sync_read_generation;
  IF OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.sync_status IS DISTINCT FROM NEW.sync_status
    OR (coalesce(length(OLD.refresh_token), 0) > 0) IS DISTINCT FROM (coalesce(length(NEW.refresh_token), 0) > 0)
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
    OR OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    NEW.sync_read_generation := OLD.sync_read_generation + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_read_generation BEFORE UPDATE ON account
FOR EACH ROW EXECUTE FUNCTION musubi_account_read_generation();
