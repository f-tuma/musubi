-- Standalone schema: never invokes Musubi migrations or product tables.
CREATE TABLE IF NOT EXISTS reference_connections (
  id text PRIMARY KEY, generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0 AND generation <= 9007199254740991),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  scope text NOT NULL, credential_ciphertext text, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_objects (
  id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0 AND revision <= 9007199254740991),
  privacy_label text NOT NULL DEFAULT 'private', privacy_generation bigint NOT NULL DEFAULT 1 CHECK (privacy_generation > 0 AND privacy_generation <= 9007199254740991),
  content jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_bindings (
  id text PRIMARY KEY, connection_id text NOT NULL REFERENCES reference_connections(id),
  object_id text NOT NULL REFERENCES reference_objects(id), calendar_id text NOT NULL, event_id text NOT NULL,
  active boolean NOT NULL DEFAULT true, source_generation bigint NOT NULL DEFAULT 1 CHECK (source_generation > 0 AND source_generation <= 9007199254740991),
  etag text NOT NULL, baseline jsonb NOT NULL,
  UNIQUE(connection_id, calendar_id, event_id)
);
CREATE INDEX IF NOT EXISTS reference_bindings_object ON reference_bindings(object_id);
CREATE TABLE IF NOT EXISTS reference_operations (
  id text PRIMARY KEY, command_id text NOT NULL, binding_id text NOT NULL REFERENCES reference_bindings(id),
  object_id text NOT NULL REFERENCES reference_objects(id), connection_id text NOT NULL REFERENCES reference_connections(id),
  calendar_id text NOT NULL, event_id text NOT NULL, accepted_revision bigint NOT NULL,
  connection_generation bigint NOT NULL, source_generation bigint NOT NULL, privacy_generation bigint NOT NULL,
  accepted_etag text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','hold','conflict','acked')),
  dispatch_possible boolean NOT NULL DEFAULT false, receipt jsonb NOT NULL,
  lease_attempt_id text, lease_until timestamptz, not_before timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connection_id, command_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_one_pending_binding ON reference_operations(binding_id) WHERE status <> 'acked';
CREATE TABLE IF NOT EXISTS reference_attempts (
  id text PRIMARY KEY, operation_id text NOT NULL REFERENCES reference_operations(id),
  dispatch_possible boolean NOT NULL DEFAULT false, recovery boolean NOT NULL DEFAULT false, receipt jsonb NOT NULL, code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Permit re-running this standalone migration on earlier local C05 fixtures.
ALTER TABLE reference_attempts ADD COLUMN IF NOT EXISTS recovery boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS reference_attempts_operation ON reference_attempts(operation_id);
CREATE OR REPLACE FUNCTION reference_connection_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Reference connection identity is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.scope IS DISTINCT FROM OLD.scope OR
    (NEW.credential_ciphertext IS NULL) IS DISTINCT FROM (OLD.credential_ciphertext IS NULL) THEN
    NEW.generation := OLD.generation + 1;
  ELSE NEW.generation := OLD.generation; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_connection_epoch ON reference_connections;
CREATE TRIGGER reference_connection_epoch BEFORE UPDATE ON reference_connections FOR EACH ROW EXECUTE FUNCTION reference_connection_epoch();
CREATE OR REPLACE FUNCTION reference_object_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Reference object identity is immutable'; END IF;
  IF NEW.content IS DISTINCT FROM OLD.content THEN NEW.revision := OLD.revision + 1;
  ELSIF NEW.revision < OLD.revision THEN NEW.revision := OLD.revision; END IF;
  IF NEW.privacy_label IS DISTINCT FROM OLD.privacy_label THEN NEW.privacy_generation := OLD.privacy_generation + 1;
  ELSE NEW.privacy_generation := OLD.privacy_generation; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_object_epoch ON reference_objects;
CREATE TRIGGER reference_object_epoch BEFORE UPDATE ON reference_objects FOR EACH ROW EXECUTE FUNCTION reference_object_epoch();
CREATE OR REPLACE FUNCTION reference_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.object_id IS DISTINCT FROM OLD.object_id THEN
    RAISE EXCEPTION 'Reference binding identity is immutable';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active OR NEW.calendar_id IS DISTINCT FROM OLD.calendar_id OR NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    NEW.source_generation := OLD.source_generation + 1;
  ELSE NEW.source_generation := OLD.source_generation; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_binding_epoch ON reference_bindings;
CREATE TRIGGER reference_binding_epoch BEFORE UPDATE ON reference_bindings FOR EACH ROW EXECUTE FUNCTION reference_binding_epoch();
CREATE OR REPLACE FUNCTION reference_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.command_id,NEW.binding_id,NEW.object_id,NEW.connection_id,NEW.calendar_id,NEW.event_id,
    NEW.accepted_revision,NEW.connection_generation,NEW.source_generation,NEW.privacy_generation,NEW.accepted_etag,NEW.fingerprint,NEW.payload,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.command_id,OLD.binding_id,OLD.object_id,OLD.connection_id,OLD.calendar_id,OLD.event_id,
    OLD.accepted_revision,OLD.connection_generation,OLD.source_generation,OLD.privacy_generation,OLD.accepted_etag,OLD.fingerprint,OLD.payload,OLD.created_at)
  THEN RAISE EXCEPTION 'Reference admitted operation is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_operation_immutable ON reference_operations;
CREATE TRIGGER reference_operation_immutable BEFORE UPDATE ON reference_operations FOR EACH ROW EXECUTE FUNCTION reference_operation_immutable();
