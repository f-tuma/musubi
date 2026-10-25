-- Bounded DAV DELETE. URLs reuse existing captured calendar_id/event_id;
-- accepted UID is independent of both the resource filename and host identity.
ALTER TABLE reference_bindings ADD COLUMN IF NOT EXISTS ical_uid text;
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS accepted_uid text;
ALTER TABLE reference_connections DROP CONSTRAINT IF EXISTS reference_connections_provider_check;
ALTER TABLE reference_connections ADD CONSTRAINT reference_connections_provider_check CHECK (provider IN ('google','microsoft','caldav'));
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_provider_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_provider_check CHECK (provider IN ('google','microsoft','caldav'));
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_provider_profile_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_provider_profile_check CHECK (
  provider='google' AND endpoint_profile='google-personal-event-'||action||'-v1' OR
  provider='microsoft' AND action='delete' AND endpoint_profile='microsoft-personal-event-delete-v1' OR
  provider='caldav' AND action='delete' AND endpoint_profile='caldav-personal-event-delete-v1'
);
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_accepted_uid_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_accepted_uid_check CHECK (
  CASE WHEN provider='caldav' THEN accepted_uid IS NOT NULL AND length(accepted_uid) BETWEEN 1 AND 2048
    AND position(chr(10) in accepted_uid)=0 AND position(chr(13) in accepted_uid)=0
  ELSE accepted_uid IS NULL END
);
ALTER TABLE reference_connections DROP CONSTRAINT IF EXISTS reference_connections_caldav_scope_check;
ALTER TABLE reference_connections ADD CONSTRAINT reference_connections_caldav_scope_check CHECK (provider<>'caldav' OR scope='');

CREATE OR REPLACE FUNCTION reference_connection_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider THEN RAISE EXCEPTION 'Reference connection identity is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.scope IS DISTINCT FROM OLD.scope OR
    (NEW.credential_ciphertext IS NULL) IS DISTINCT FROM (OLD.credential_ciphertext IS NULL) OR
    (OLD.provider='caldav' AND NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext) THEN
    NEW.generation := OLD.generation + 1;
  ELSE NEW.generation := OLD.generation; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.object_id IS DISTINCT FROM OLD.object_id OR
    NEW.create_operation_id IS DISTINCT FROM OLD.create_operation_id THEN RAISE EXCEPTION 'Reference binding identity is immutable'; END IF;
  IF NEW.active IS DISTINCT FROM OLD.active OR NEW.calendar_id IS DISTINCT FROM OLD.calendar_id OR NEW.event_id IS DISTINCT FROM OLD.event_id OR
    NEW.destination_lifecycle IS DISTINCT FROM OLD.destination_lifecycle OR NEW.ical_uid IS DISTINCT FROM OLD.ical_uid THEN
    NEW.source_generation := OLD.source_generation + 1;
  ELSE NEW.source_generation := OLD.source_generation; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.command_id,NEW.binding_id,NEW.object_id,NEW.connection_id,NEW.calendar_id,NEW.event_id,
    NEW.accepted_revision,NEW.connection_generation,NEW.source_generation,NEW.privacy_generation,NEW.accepted_etag,NEW.fingerprint,NEW.payload,NEW.created_at,
    NEW.action,NEW.canonical_generation,NEW.provider,NEW.endpoint_profile,NEW.accepted_uid)
    IS DISTINCT FROM ROW(OLD.id,OLD.command_id,OLD.binding_id,OLD.object_id,OLD.connection_id,OLD.calendar_id,OLD.event_id,
    OLD.accepted_revision,OLD.connection_generation,OLD.source_generation,OLD.privacy_generation,OLD.accepted_etag,OLD.fingerprint,OLD.payload,OLD.created_at,
    OLD.action,OLD.canonical_generation,OLD.provider,OLD.endpoint_profile,OLD.accepted_uid)
  THEN RAISE EXCEPTION 'Reference admitted operation is immutable'; END IF;
  RETURN NEW;
END $$;
