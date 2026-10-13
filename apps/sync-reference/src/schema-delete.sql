-- C07 forward-only additions. C05/C06 table identities, rows, FKs and indexes survive.
ALTER TABLE reference_objects ADD COLUMN IF NOT EXISTS canonical_lifecycle text NOT NULL DEFAULT 'active'
  CHECK (canonical_lifecycle IN ('active','tombstoned'));
ALTER TABLE reference_objects ADD COLUMN IF NOT EXISTS lifecycle_generation bigint NOT NULL DEFAULT 1
  CHECK (lifecycle_generation > 0 AND lifecycle_generation <= 9007199254740991);
ALTER TABLE reference_bindings ADD COLUMN IF NOT EXISTS destination_lifecycle text NOT NULL DEFAULT 'present'
  CHECK (destination_lifecycle IN ('present','absent'));
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'update' CHECK (action IN ('update','delete'));
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS canonical_generation bigint NOT NULL DEFAULT 1
  CHECK (canonical_generation > 0 AND canonical_generation <= 9007199254740991);
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS delete_acceptance_status smallint CHECK (delete_acceptance_status IN (200,201,204,404,410));
ALTER TABLE reference_attempts ADD COLUMN IF NOT EXISTS delete_acceptance_status smallint CHECK (delete_acceptance_status IN (200,201,204,404,410));

CREATE OR REPLACE FUNCTION reference_object_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Reference object identity is immutable'; END IF;
  IF NEW.canonical_lifecycle IS DISTINCT FROM OLD.canonical_lifecycle THEN
    NEW.lifecycle_generation := OLD.lifecycle_generation + 1;
  ELSE NEW.lifecycle_generation := OLD.lifecycle_generation; END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.canonical_lifecycle IS DISTINCT FROM OLD.canonical_lifecycle THEN
    NEW.revision := OLD.revision + 1;
  ELSIF NEW.revision < OLD.revision THEN NEW.revision := OLD.revision; END IF;
  IF NEW.privacy_label IS DISTINCT FROM OLD.privacy_label THEN NEW.privacy_generation := OLD.privacy_generation + 1;
  ELSE NEW.privacy_generation := OLD.privacy_generation; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.object_id IS DISTINCT FROM OLD.object_id THEN
    RAISE EXCEPTION 'Reference binding identity is immutable';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active OR NEW.calendar_id IS DISTINCT FROM OLD.calendar_id OR NEW.event_id IS DISTINCT FROM OLD.event_id OR
    NEW.destination_lifecycle IS DISTINCT FROM OLD.destination_lifecycle THEN
    NEW.source_generation := OLD.source_generation + 1;
  ELSE NEW.source_generation := OLD.source_generation; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reference_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.command_id,NEW.binding_id,NEW.object_id,NEW.connection_id,NEW.calendar_id,NEW.event_id,
    NEW.accepted_revision,NEW.connection_generation,NEW.source_generation,NEW.privacy_generation,NEW.accepted_etag,NEW.fingerprint,NEW.payload,NEW.created_at,
    NEW.action,NEW.canonical_generation)
    IS DISTINCT FROM ROW(OLD.id,OLD.command_id,OLD.binding_id,OLD.object_id,OLD.connection_id,OLD.calendar_id,OLD.event_id,
    OLD.accepted_revision,OLD.connection_generation,OLD.source_generation,OLD.privacy_generation,OLD.accepted_etag,OLD.fingerprint,OLD.payload,OLD.created_at,
    OLD.action,OLD.canonical_generation)
  THEN RAISE EXCEPTION 'Reference admitted operation is immutable'; END IF;
  RETURN NEW;
END $$;
