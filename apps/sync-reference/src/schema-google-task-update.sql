-- Separate task namespace. Existing seven event families/constraints/history stay intact.
CREATE TABLE IF NOT EXISTS reference_task_objects (
  id text PRIMARY KEY, content jsonb NOT NULL CHECK (jsonb_typeof(content)='object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  privacy_label text NOT NULL DEFAULT 'private', privacy_generation bigint NOT NULL DEFAULT 1 CHECK (privacy_generation BETWEEN 1 AND 9007199254740991),
  canonical_lifecycle text NOT NULL DEFAULT 'active' CHECK (canonical_lifecycle IN ('active','tombstoned')),
  lifecycle_generation bigint NOT NULL DEFAULT 1 CHECK (lifecycle_generation BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS reference_task_bindings (
  id text PRIMARY KEY, connection_id text NOT NULL REFERENCES reference_connections(id),
  object_id text NOT NULL REFERENCES reference_task_objects(id), task_list_id text NOT NULL CHECK(length(task_list_id) BETWEEN 1 AND 2048 AND task_list_id<>'@default'),
  task_id text NOT NULL CHECK(length(task_id) BETWEEN 1 AND 2048), active boolean NOT NULL DEFAULT true,
  source_generation bigint NOT NULL DEFAULT 1 CHECK (source_generation BETWEEN 1 AND 9007199254740991),
  etag text NOT NULL CHECK(length(etag)<=2048 AND etag ~ ('^"[!#-~'||chr(128)||'-'||chr(255)||']*"$')),
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline)='object'), UNIQUE(connection_id,task_list_id,task_id)
);
CREATE INDEX IF NOT EXISTS reference_task_bindings_object ON reference_task_bindings(object_id);
CREATE TABLE IF NOT EXISTS reference_task_operations (
  id text PRIMARY KEY, command_id text NOT NULL, binding_id text NOT NULL REFERENCES reference_task_bindings(id),
  object_id text NOT NULL REFERENCES reference_task_objects(id), connection_id text NOT NULL REFERENCES reference_connections(id),
  provider text NOT NULL CHECK(provider='google'), endpoint_profile text NOT NULL CHECK(endpoint_profile='google-task-update-v1'),
  action text NOT NULL CHECK(action='update'), task_list_id text NOT NULL, task_id text NOT NULL,
  accepted_revision bigint NOT NULL CHECK(accepted_revision BETWEEN 1 AND 9007199254740991),
  connection_generation bigint NOT NULL CHECK(connection_generation BETWEEN 1 AND 9007199254740991),
  source_generation bigint NOT NULL CHECK(source_generation BETWEEN 1 AND 9007199254740991),
  privacy_generation bigint NOT NULL CHECK(privacy_generation BETWEEN 1 AND 9007199254740991),
  canonical_generation bigint NOT NULL CHECK(canonical_generation BETWEEN 1 AND 9007199254740991),
  accepted_etag text NOT NULL CHECK(length(accepted_etag)<=2048 AND accepted_etag ~ ('^"[!#-~'||chr(128)||'-'||chr(255)||']*"$')),
  fingerprint text NOT NULL, payload jsonb NOT NULL, saved_projection jsonb NOT NULL,
  field_mask text[] NOT NULL CHECK(field_mask = array_remove(ARRAY[
    CASE WHEN 'due'=ANY(field_mask) THEN 'due' END, CASE WHEN 'notes'=ANY(field_mask) THEN 'notes' END,
    CASE WHEN 'status'=ANY(field_mask) THEN 'status' END, CASE WHEN 'title'=ANY(field_mask) THEN 'title' END],NULL)),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','hold','conflict','acked')),
  dispatch_possible boolean NOT NULL DEFAULT false, receipt jsonb NOT NULL,
  native_acceptance_status smallint CHECK(native_acceptance_status IN (200,201,204)),
  lease_attempt_id text, lease_until timestamptz, not_before timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(connection_id,command_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_task_one_pending_binding ON reference_task_operations(binding_id) WHERE status<>'acked';
CREATE TABLE IF NOT EXISTS reference_task_attempts (
  id text PRIMARY KEY, operation_id text NOT NULL REFERENCES reference_task_operations(id),
  dispatch_possible boolean NOT NULL DEFAULT false, recovery boolean NOT NULL DEFAULT false, receipt jsonb NOT NULL, code text,
  native_acceptance_status smallint CHECK(native_acceptance_status IN (200,201,204)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS reference_task_attempts_operation ON reference_task_attempts(operation_id);
CREATE OR REPLACE FUNCTION reference_task_object_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Reference task object identity is immutable'; END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.canonical_lifecycle IS DISTINCT FROM OLD.canonical_lifecycle THEN NEW.revision:=OLD.revision+1;
  ELSIF NEW.revision<OLD.revision THEN NEW.revision:=OLD.revision; END IF;
  IF NEW.privacy_label IS DISTINCT FROM OLD.privacy_label THEN NEW.privacy_generation:=OLD.privacy_generation+1; ELSE NEW.privacy_generation:=OLD.privacy_generation; END IF;
  IF NEW.canonical_lifecycle IS DISTINCT FROM OLD.canonical_lifecycle THEN NEW.lifecycle_generation:=OLD.lifecycle_generation+1; ELSE NEW.lifecycle_generation:=OLD.lifecycle_generation; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_task_object_epoch ON reference_task_objects;
CREATE TRIGGER reference_task_object_epoch BEFORE UPDATE ON reference_task_objects FOR EACH ROW EXECUTE FUNCTION reference_task_object_epoch();
CREATE OR REPLACE FUNCTION reference_task_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.connection_id,NEW.object_id,NEW.task_list_id,NEW.task_id) IS DISTINCT FROM ROW(OLD.id,OLD.connection_id,OLD.object_id,OLD.task_list_id,OLD.task_id)
  THEN RAISE EXCEPTION 'Reference task binding identity is immutable'; END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN NEW.source_generation:=OLD.source_generation+1; ELSE NEW.source_generation:=OLD.source_generation; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_task_binding_epoch ON reference_task_bindings;
CREATE TRIGGER reference_task_binding_epoch BEFORE UPDATE ON reference_task_bindings FOR EACH ROW EXECUTE FUNCTION reference_task_binding_epoch();
CREATE OR REPLACE FUNCTION reference_task_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.command_id,NEW.binding_id,NEW.object_id,NEW.connection_id,NEW.provider,NEW.endpoint_profile,NEW.action,NEW.task_list_id,NEW.task_id,
    NEW.accepted_revision,NEW.connection_generation,NEW.source_generation,NEW.privacy_generation,NEW.canonical_generation,NEW.accepted_etag,
    NEW.fingerprint,NEW.payload,NEW.saved_projection,NEW.field_mask,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.command_id,OLD.binding_id,OLD.object_id,OLD.connection_id,OLD.provider,OLD.endpoint_profile,OLD.action,OLD.task_list_id,OLD.task_id,
    OLD.accepted_revision,OLD.connection_generation,OLD.source_generation,OLD.privacy_generation,OLD.canonical_generation,OLD.accepted_etag,
    OLD.fingerprint,OLD.payload,OLD.saved_projection,OLD.field_mask,OLD.created_at) OR
    (to_jsonb(NEW)->'delete_accepted_baseline') IS DISTINCT FROM (to_jsonb(OLD)->'delete_accepted_baseline')
  THEN RAISE EXCEPTION 'Reference task admitted operation is immutable'; END IF;
  IF OLD.dispatch_possible AND NOT NEW.dispatch_possible THEN RAISE EXCEPTION 'Reference task dispatch evidence is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_task_operation_immutable ON reference_task_operations;
CREATE TRIGGER reference_task_operation_immutable BEFORE UPDATE ON reference_task_operations FOR EACH ROW EXECUTE FUNCTION reference_task_operation_immutable();
