-- Immutable future intent is separate from materialized canonical truth. Keep
-- every old table/index (especially one_pending_binding) at its existing OID.
CREATE TABLE IF NOT EXISTS reference_task_intents (
  id text PRIMARY KEY, command_id text NOT NULL, binding_id text NOT NULL REFERENCES reference_task_bindings(id),
  object_id text NOT NULL REFERENCES reference_task_objects(id), connection_id text NOT NULL REFERENCES reference_connections(id),
  task_list_id text NOT NULL, action text NOT NULL CHECK(action IN ('update','delete')),
  root_create_operation_id text NOT NULL REFERENCES reference_task_operations(id),
  predecessor_intent_id text REFERENCES reference_task_intents(id), predecessor_operation_id text NOT NULL,
  expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
  accepted_revision bigint NOT NULL CHECK(accepted_revision=expected_revision+1),
  captured_object_revision bigint NOT NULL CHECK(captured_object_revision BETWEEN 1 AND 9007199254740991),
  connection_generation bigint NOT NULL CHECK(connection_generation BETWEEN 1 AND 9007199254740991),
  source_generation bigint NOT NULL CHECK(source_generation BETWEEN 1 AND 9007199254740991),
  privacy_generation bigint NOT NULL CHECK(privacy_generation BETWEEN 1 AND 9007199254740991),
  reservation_canonical_generation bigint NOT NULL CHECK(reservation_canonical_generation BETWEEN 1 AND 9007199254740991),
  canonical_generation bigint NOT NULL CHECK(canonical_generation BETWEEN 1 AND 9007199254740991),
  canonical_lifecycle text NOT NULL CHECK(canonical_lifecycle IN ('active','tombstoned')),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'), payload jsonb NOT NULL,
  fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(id<>predecessor_operation_id AND id<>root_create_operation_id),
  CHECK(predecessor_intent_id IS NULL AND predecessor_operation_id=root_create_operation_id OR predecessor_intent_id IS NOT NULL AND predecessor_intent_id=predecessor_operation_id),
  CHECK(action='update' AND canonical_lifecycle='active' AND canonical_generation=reservation_canonical_generation OR
    action='delete' AND canonical_lifecycle='tombstoned' AND canonical_generation=reservation_canonical_generation+1),
  UNIQUE(connection_id,command_id), UNIQUE(predecessor_operation_id), UNIQUE(binding_id,accepted_revision)
);
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS predecessor_operation_id text REFERENCES reference_task_operations(id);
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS queued_intent_id text REFERENCES reference_task_intents(id);
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS resolution_basis jsonb;
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS completion_evidence jsonb;
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_delete_capture_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_delete_capture_check CHECK(
  action='update' AND (task_id IS NOT NULL OR predecessor_operation_id IS NOT NULL) AND accepted_etag IS NOT NULL AND saved_projection IS NOT NULL AND field_mask IS NOT NULL AND delete_accepted_baseline IS NULL AND
    delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL OR
  action='delete' AND (task_id IS NOT NULL OR predecessor_operation_id IS NOT NULL) AND accepted_etag IS NOT NULL AND saved_projection IS NULL AND field_mask IS NULL AND delete_accepted_baseline IS NOT NULL AND
    jsonb_typeof(delete_accepted_baseline)='object' AND native_acceptance_status IS NULL OR
  action='create' AND task_id IS NULL AND accepted_etag IS NULL AND saved_projection IS NULL AND field_mask IS NULL AND delete_accepted_baseline IS NULL AND
    native_acceptance_status IS NULL AND delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL
);
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_causal_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_causal_check CHECK(
  (predecessor_operation_id IS NULL AND queued_intent_id IS NULL AND resolution_basis IS NULL OR
    action IN ('update','delete') AND task_id IS NULL AND predecessor_operation_id IS NOT NULL AND queued_intent_id IS NOT NULL AND queued_intent_id=id AND resolution_basis IS NOT NULL AND jsonb_typeof(resolution_basis)='object') AND
  (completion_evidence IS NULL OR jsonb_typeof(completion_evidence)='object' AND status='acked')
);
CREATE OR REPLACE FUNCTION reference_task_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Reference queued task intent is immutable'; END $$;
DROP TRIGGER IF EXISTS reference_task_intent_immutable ON reference_task_intents;
CREATE TRIGGER reference_task_intent_immutable BEFORE UPDATE OR DELETE ON reference_task_intents FOR EACH ROW EXECUTE FUNCTION reference_task_intent_immutable();
CREATE OR REPLACE FUNCTION reference_task_causal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.predecessor_operation_id,NEW.queued_intent_id,NEW.resolution_basis) IS DISTINCT FROM ROW(OLD.predecessor_operation_id,OLD.queued_intent_id,OLD.resolution_basis) OR
    OLD.completion_evidence IS NOT NULL AND NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence THEN
    RAISE EXCEPTION 'Reference task causal evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_task_causal_immutable ON reference_task_operations;
CREATE TRIGGER reference_task_causal_immutable BEFORE UPDATE ON reference_task_operations FOR EACH ROW EXECUTE FUNCTION reference_task_causal_immutable();
