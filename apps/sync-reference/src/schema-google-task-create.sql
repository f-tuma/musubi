-- Tenth independent profile. Existing event/task tables and indexes are retained.
ALTER TABLE reference_task_bindings ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE reference_task_bindings ALTER COLUMN etag DROP NOT NULL;
ALTER TABLE reference_task_bindings ALTER COLUMN baseline DROP NOT NULL;
ALTER TABLE reference_task_bindings ADD COLUMN IF NOT EXISTS create_operation_id text;
ALTER TABLE reference_task_bindings ADD COLUMN IF NOT EXISTS create_profile text;
ALTER TABLE reference_task_bindings DROP CONSTRAINT IF EXISTS reference_task_bindings_destination_lifecycle_check;
ALTER TABLE reference_task_bindings ADD CONSTRAINT reference_task_bindings_destination_lifecycle_check CHECK(destination_lifecycle IN ('reserved','present','absent'));
ALTER TABLE reference_task_bindings DROP CONSTRAINT IF EXISTS reference_task_bindings_create_reservation_check;
ALTER TABLE reference_task_bindings ADD CONSTRAINT reference_task_bindings_create_reservation_check CHECK(
  ((create_operation_id IS NULL) = (create_profile IS NULL)) AND
  (create_operation_id IS NULL OR create_operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
  (create_profile IS NULL OR create_profile='google-task-create-v1') AND
  CASE WHEN destination_lifecycle='reserved' THEN
    create_operation_id IS NOT NULL AND task_id IS NULL AND etag IS NULL AND baseline IS NULL
  ELSE task_id IS NOT NULL AND etag IS NOT NULL AND baseline IS NOT NULL END
);
ALTER TABLE reference_task_operations ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE reference_task_operations ALTER COLUMN accepted_etag DROP NOT NULL;
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS create_candidate_id text;
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS create_candidate_validator text;
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS create_acceptance_status smallint;
ALTER TABLE reference_task_attempts ADD COLUMN IF NOT EXISTS create_candidate_id text;
ALTER TABLE reference_task_attempts ADD COLUMN IF NOT EXISTS create_candidate_validator text;
ALTER TABLE reference_task_attempts ADD COLUMN IF NOT EXISTS create_acceptance_status smallint;
COMMENT ON COLUMN reference_task_operations.create_candidate_validator IS 'JSON.stringify encoded raw response validator, never conditional authority; SQL NULL means no native string.';
COMMENT ON COLUMN reference_task_attempts.create_candidate_validator IS 'JSON.stringify encoded raw response validator, never conditional authority; SQL NULL means no native string.';
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_action_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_action_check CHECK(action IN ('create','update','delete'));
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_endpoint_profile_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_endpoint_profile_check CHECK(endpoint_profile='google-task-'||action||'-v1');
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_delete_capture_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_delete_capture_check CHECK(
  action='update' AND task_id IS NOT NULL AND accepted_etag IS NOT NULL AND saved_projection IS NOT NULL AND field_mask IS NOT NULL AND delete_accepted_baseline IS NULL AND
    delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL OR
  action='delete' AND task_id IS NOT NULL AND accepted_etag IS NOT NULL AND saved_projection IS NULL AND field_mask IS NULL AND delete_accepted_baseline IS NOT NULL AND
    jsonb_typeof(delete_accepted_baseline)='object' AND native_acceptance_status IS NULL OR
  action='create' AND task_id IS NULL AND accepted_etag IS NULL AND saved_projection IS NULL AND field_mask IS NULL AND delete_accepted_baseline IS NULL AND
    native_acceptance_status IS NULL AND delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL
);
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_create_evidence_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_create_evidence_check CHECK(
  (create_candidate_id IS NULL OR length(create_candidate_id) BETWEEN 1 AND 2048) AND
  (create_candidate_id IS NOT NULL OR create_candidate_validator IS NULL) AND
  (create_acceptance_status IS NULL OR create_acceptance_status IN (200,201,204)) AND
  (create_candidate_id IS NULL OR create_acceptance_status IS NOT NULL) AND
  (action='create' OR create_candidate_id IS NULL AND create_candidate_validator IS NULL AND create_acceptance_status IS NULL)
);
ALTER TABLE reference_task_attempts DROP CONSTRAINT IF EXISTS reference_task_attempts_create_evidence_check;
ALTER TABLE reference_task_attempts ADD CONSTRAINT reference_task_attempts_create_evidence_check CHECK(
  (create_candidate_id IS NULL OR length(create_candidate_id) BETWEEN 1 AND 2048) AND
  (create_candidate_id IS NOT NULL OR create_candidate_validator IS NULL) AND
  (create_acceptance_status IS NULL OR create_acceptance_status IN (200,201,204)) AND
  (create_candidate_id IS NULL OR create_acceptance_status IS NOT NULL) AND
  (create_acceptance_status IS NULL OR native_acceptance_status IS NULL AND delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL)
);
CREATE OR REPLACE FUNCTION reference_task_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.connection_id,NEW.object_id,NEW.task_list_id,NEW.create_operation_id,NEW.create_profile)
    IS DISTINCT FROM ROW(OLD.id,OLD.connection_id,OLD.object_id,OLD.task_list_id,OLD.create_operation_id,OLD.create_profile) THEN
    RAISE EXCEPTION 'Reference task binding identity is immutable';
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id AND NOT (
    OLD.destination_lifecycle='reserved' AND NEW.destination_lifecycle='present' AND OLD.task_id IS NULL AND NEW.task_id IS NOT NULL AND
    OLD.create_operation_id IS NOT NULL AND OLD.create_profile='google-task-create-v1') THEN
    RAISE EXCEPTION 'Reference task binding address is immutable';
  END IF;
  -- Adoption is a new addressed source epoch. DELETE absence still is not grant retirement.
  IF NEW.active IS DISTINCT FROM OLD.active OR NEW.task_id IS DISTINCT FROM OLD.task_id THEN NEW.source_generation:=OLD.source_generation+1;
  ELSE NEW.source_generation:=OLD.source_generation; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_task_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.command_id,NEW.binding_id,NEW.object_id,NEW.connection_id,NEW.provider,NEW.endpoint_profile,NEW.action,NEW.task_list_id,NEW.task_id,
    NEW.accepted_revision,NEW.connection_generation,NEW.source_generation,NEW.privacy_generation,NEW.canonical_generation,NEW.accepted_etag,
    NEW.fingerprint,NEW.payload,NEW.saved_projection,NEW.field_mask,NEW.created_at,NEW.delete_accepted_baseline)
    IS DISTINCT FROM ROW(OLD.id,OLD.command_id,OLD.binding_id,OLD.object_id,OLD.connection_id,OLD.provider,OLD.endpoint_profile,OLD.action,OLD.task_list_id,OLD.task_id,
    OLD.accepted_revision,OLD.connection_generation,OLD.source_generation,OLD.privacy_generation,OLD.canonical_generation,OLD.accepted_etag,
    OLD.fingerprint,OLD.payload,OLD.saved_projection,OLD.field_mask,OLD.created_at,OLD.delete_accepted_baseline)
  THEN RAISE EXCEPTION 'Reference task admitted operation is immutable'; END IF;
  IF OLD.dispatch_possible AND NOT NEW.dispatch_possible THEN RAISE EXCEPTION 'Reference task dispatch evidence is immutable'; END IF;
  IF OLD.create_candidate_id IS NOT NULL AND ROW(NEW.create_candidate_id,NEW.create_candidate_validator) IS DISTINCT FROM ROW(OLD.create_candidate_id,OLD.create_candidate_validator) OR
    OLD.create_acceptance_status IS NOT NULL AND NEW.create_acceptance_status IS DISTINCT FROM OLD.create_acceptance_status
  THEN RAISE EXCEPTION 'Reference task CREATE evidence is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_task_attempt_create_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.create_candidate_id IS NOT NULL AND ROW(NEW.create_candidate_id,NEW.create_candidate_validator) IS DISTINCT FROM ROW(OLD.create_candidate_id,OLD.create_candidate_validator) OR
    OLD.create_acceptance_status IS NOT NULL AND NEW.create_acceptance_status IS DISTINCT FROM OLD.create_acceptance_status
  THEN RAISE EXCEPTION 'Reference task CREATE attempt evidence is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_task_attempt_create_evidence ON reference_task_attempts;
CREATE TRIGGER reference_task_attempt_create_evidence BEFORE UPDATE ON reference_task_attempts FOR EACH ROW EXECUTE FUNCTION reference_task_attempt_create_evidence();
