-- C07 Google personal CREATE: forward-only reservation authority, no fake ETags.
-- Existing UPDATE/DELETE payloads, table identities and historical attempts survive.
ALTER TABLE reference_bindings ALTER COLUMN etag DROP NOT NULL;
ALTER TABLE reference_bindings ALTER COLUMN baseline DROP NOT NULL;
ALTER TABLE reference_operations ALTER COLUMN accepted_etag DROP NOT NULL;
ALTER TABLE reference_bindings ADD COLUMN IF NOT EXISTS create_operation_id text;

ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_action_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_action_check CHECK (action IN ('create','update','delete'));
ALTER TABLE reference_bindings DROP CONSTRAINT IF EXISTS reference_bindings_destination_lifecycle_check;
ALTER TABLE reference_bindings ADD CONSTRAINT reference_bindings_destination_lifecycle_check CHECK (destination_lifecycle IN ('reserved','present','absent'));
ALTER TABLE reference_bindings DROP CONSTRAINT IF EXISTS reference_bindings_create_reservation_check;
ALTER TABLE reference_bindings ADD CONSTRAINT reference_bindings_create_reservation_check CHECK (
  (create_operation_id IS NULL OR create_operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
  CASE WHEN destination_lifecycle='reserved' THEN
    create_operation_id IS NOT NULL AND event_id='musubi'||replace(create_operation_id,'-','') AND etag IS NULL AND baseline IS NULL
  ELSE etag IS NOT NULL AND baseline IS NOT NULL END
);
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_action_validator_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_action_validator_check CHECK (
  CASE WHEN action='create' THEN accepted_etag IS NULL ELSE accepted_etag IS NOT NULL END
);

CREATE OR REPLACE FUNCTION reference_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.object_id IS DISTINCT FROM OLD.object_id OR
    NEW.create_operation_id IS DISTINCT FROM OLD.create_operation_id THEN
    RAISE EXCEPTION 'Reference binding identity is immutable';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active OR NEW.calendar_id IS DISTINCT FROM OLD.calendar_id OR NEW.event_id IS DISTINCT FROM OLD.event_id OR
    NEW.destination_lifecycle IS DISTINCT FROM OLD.destination_lifecycle THEN
    NEW.source_generation := OLD.source_generation + 1;
  ELSE NEW.source_generation := OLD.source_generation; END IF;
  RETURN NEW;
END $$;
