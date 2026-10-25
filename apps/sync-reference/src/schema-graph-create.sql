-- Graph assigns the resource ID after POST. The admitted operation keeps NULL
-- permanently; only its reserved binding can atomically adopt a verified ID.
ALTER TABLE reference_bindings ADD COLUMN IF NOT EXISTS create_profile text;
UPDATE reference_bindings b SET create_profile='google-personal-event-create-v1'
  FROM reference_connections c WHERE b.connection_id=c.id AND c.provider='google'
  AND b.create_operation_id IS NOT NULL AND b.create_profile IS NULL;
ALTER TABLE reference_bindings ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE reference_operations ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS create_candidate_id text;
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS create_acceptance_validator text;
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS create_acceptance_status smallint;
ALTER TABLE reference_attempts ADD COLUMN IF NOT EXISTS create_candidate_id text;
ALTER TABLE reference_attempts ADD COLUMN IF NOT EXISTS create_acceptance_validator text;
ALTER TABLE reference_attempts ADD COLUMN IF NOT EXISTS create_acceptance_status smallint;
COMMENT ON COLUMN reference_operations.create_acceptance_validator IS 'JSON.stringify encoded raw native acceptance string; SQL NULL is native NULL. Never a conditional validator.';
COMMENT ON COLUMN reference_attempts.create_acceptance_validator IS 'JSON.stringify encoded raw native acceptance string; SQL NULL is native NULL. Never a conditional validator.';

-- Preserve the later DAV CREATE shape on full migration reruns. Initial
-- upgrades still install this Graph widening before the DAV migration runs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='reference_bindings'::regclass AND conname='reference_bindings_caldav_create_identity_check') THEN
    ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_provider_profile_check;
    ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_provider_profile_check CHECK (
      provider='google' AND endpoint_profile='google-personal-event-'||action||'-v1' OR
      provider='microsoft' AND action IN ('create','delete') AND endpoint_profile='microsoft-personal-event-'||action||'-v1' OR
      provider='caldav' AND action='delete' AND endpoint_profile='caldav-personal-event-delete-v1'
    );
    ALTER TABLE reference_bindings DROP CONSTRAINT IF EXISTS reference_bindings_create_reservation_check;
    ALTER TABLE reference_bindings ADD CONSTRAINT reference_bindings_create_reservation_check CHECK (
      (create_operation_id IS NULL OR create_operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
      ((create_operation_id IS NULL) = (create_profile IS NULL)) AND
      (create_profile IS NULL OR create_profile IN ('google-personal-event-create-v1','microsoft-personal-event-create-v1')) AND
      CASE WHEN destination_lifecycle='reserved' THEN
        create_operation_id IS NOT NULL AND etag IS NULL AND baseline IS NULL AND
        CASE WHEN create_profile='microsoft-personal-event-create-v1' THEN event_id IS NULL
          ELSE event_id IS NOT NULL AND event_id='musubi'||replace(create_operation_id,'-','') END
      ELSE event_id IS NOT NULL AND length(event_id)>0 AND baseline IS NOT NULL AND
        CASE WHEN create_profile='microsoft-personal-event-create-v1' THEN
          etag IS NULL OR length(etag)<=2048 AND etag ~ ('^W/"[!#-~'||chr(128)||'-'||chr(255)||']+"$')
        ELSE etag IS NOT NULL END END
    );
  END IF;
END $$;
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_resource_identity_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_resource_identity_check CHECK (
  CASE WHEN provider='microsoft' AND action='create' AND endpoint_profile='microsoft-personal-event-create-v1'
    THEN event_id IS NULL AND accepted_etag IS NULL ELSE event_id IS NOT NULL AND length(event_id)>0 END
);
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_create_evidence_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_create_evidence_check CHECK (
  (create_candidate_id IS NULL OR length(create_candidate_id) BETWEEN 1 AND 2048) AND
  (create_acceptance_status IS NULL OR create_acceptance_status IN (200,201,204)) AND
  (create_acceptance_status IS NULL OR create_candidate_id IS NOT NULL) AND
  (create_acceptance_status IS NOT NULL OR create_acceptance_validator IS NULL) AND
  (provider='microsoft' AND action='create' OR create_candidate_id IS NULL AND create_acceptance_status IS NULL AND create_acceptance_validator IS NULL)
);
ALTER TABLE reference_attempts DROP CONSTRAINT IF EXISTS reference_attempts_create_evidence_check;
ALTER TABLE reference_attempts ADD CONSTRAINT reference_attempts_create_evidence_check CHECK (
  (create_candidate_id IS NULL OR length(create_candidate_id) BETWEEN 1 AND 2048) AND
  (create_acceptance_status IS NULL OR create_acceptance_status IN (200,201,204)) AND
  (create_acceptance_status IS NULL OR create_candidate_id IS NOT NULL) AND
  (create_acceptance_status IS NOT NULL OR create_acceptance_validator IS NULL)
);

-- Compatibility is restricted to the old Google reservation shape and an
-- actual Google connection. Microsoft never receives an inferred profile.
CREATE OR REPLACE FUNCTION reference_binding_create_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.create_profile IS NULL AND NEW.create_operation_id IS NOT NULL AND
    NEW.event_id='musubi'||replace(NEW.create_operation_id,'-','') AND
    EXISTS(SELECT 1 FROM reference_connections WHERE id=NEW.connection_id AND provider='google') THEN
    NEW.create_profile := 'google-personal-event-create-v1';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_binding_create_profile ON reference_bindings;
CREATE TRIGGER reference_binding_create_profile BEFORE INSERT ON reference_bindings FOR EACH ROW EXECUTE FUNCTION reference_binding_create_profile();
CREATE OR REPLACE FUNCTION reference_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.object_id IS DISTINCT FROM OLD.object_id OR
    NEW.create_operation_id IS DISTINCT FROM OLD.create_operation_id OR NEW.create_profile IS DISTINCT FROM OLD.create_profile THEN
    RAISE EXCEPTION 'Reference binding identity is immutable';
  END IF;
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
  IF OLD.create_candidate_id IS NOT NULL AND NEW.create_candidate_id IS DISTINCT FROM OLD.create_candidate_id OR
    OLD.create_acceptance_status IS NOT NULL AND ROW(NEW.create_acceptance_status,NEW.create_acceptance_validator) IS DISTINCT FROM ROW(OLD.create_acceptance_status,OLD.create_acceptance_validator)
  THEN RAISE EXCEPTION 'Reference CREATE evidence identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_attempt_create_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.create_candidate_id IS NOT NULL AND NEW.create_candidate_id IS DISTINCT FROM OLD.create_candidate_id OR
    OLD.create_acceptance_status IS NOT NULL AND ROW(NEW.create_acceptance_status,NEW.create_acceptance_validator) IS DISTINCT FROM ROW(OLD.create_acceptance_status,OLD.create_acceptance_validator)
  THEN RAISE EXCEPTION 'Reference CREATE attempt evidence identity is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_attempt_create_evidence ON reference_attempts;
CREATE TRIGGER reference_attempt_create_evidence BEFORE UPDATE ON reference_attempts FOR EACH ROW EXECUTE FUNCTION reference_attempt_create_evidence();
