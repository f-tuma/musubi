-- Bounded second-provider profile. Existing Google rows keep their original
-- identities, epochs, validators, payloads, receipts and attempt history.
ALTER TABLE reference_connections ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google'
  CHECK (provider IN ('google','microsoft'));
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google'
  CHECK (provider IN ('google','microsoft'));
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS endpoint_profile text;
UPDATE reference_operations SET endpoint_profile='google-personal-event-'||action||'-v1' WHERE endpoint_profile IS NULL AND provider='google';
ALTER TABLE reference_operations ALTER COLUMN endpoint_profile SET NOT NULL;
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_provider_profile_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_provider_profile_check CHECK (
  provider='google' AND endpoint_profile='google-personal-event-'||action||'-v1' OR
  provider='microsoft' AND action='delete' AND endpoint_profile='microsoft-personal-event-delete-v1'
);
-- Compatibility for the existing Google-only SQL/CLI: metadata is stamped once
-- at INSERT, never inferred from a mutable payload while an operation runs.
CREATE OR REPLACE FUNCTION reference_operation_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider='google' AND NEW.endpoint_profile IS NULL THEN
    NEW.endpoint_profile := 'google-personal-event-'||NEW.action||'-v1';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_operation_profile ON reference_operations;
CREATE TRIGGER reference_operation_profile BEFORE INSERT ON reference_operations FOR EACH ROW EXECUTE FUNCTION reference_operation_profile();

CREATE OR REPLACE FUNCTION reference_connection_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider THEN RAISE EXCEPTION 'Reference connection identity is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.scope IS DISTINCT FROM OLD.scope OR
    (NEW.credential_ciphertext IS NULL) IS DISTINCT FROM (OLD.credential_ciphertext IS NULL) THEN
    NEW.generation := OLD.generation + 1;
  ELSE NEW.generation := OLD.generation; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.command_id,NEW.binding_id,NEW.object_id,NEW.connection_id,NEW.calendar_id,NEW.event_id,
    NEW.accepted_revision,NEW.connection_generation,NEW.source_generation,NEW.privacy_generation,NEW.accepted_etag,NEW.fingerprint,NEW.payload,NEW.created_at,
    NEW.action,NEW.canonical_generation,NEW.provider,NEW.endpoint_profile)
    IS DISTINCT FROM ROW(OLD.id,OLD.command_id,OLD.binding_id,OLD.object_id,OLD.connection_id,OLD.calendar_id,OLD.event_id,
    OLD.accepted_revision,OLD.connection_generation,OLD.source_generation,OLD.privacy_generation,OLD.accepted_etag,OLD.fingerprint,OLD.payload,OLD.created_at,
    OLD.action,OLD.canonical_generation,OLD.provider,OLD.endpoint_profile)
  THEN RAISE EXCEPTION 'Reference admitted operation is immutable'; END IF;
  RETURN NEW;
END $$;
