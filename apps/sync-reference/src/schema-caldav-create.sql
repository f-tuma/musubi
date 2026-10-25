-- Conditional DAV CREATE reserves a known URL/UID from the original UUID.
-- No native candidate ID or Graph one-shot evidence semantics participate.
ALTER TABLE reference_operations ADD COLUMN IF NOT EXISTS caldav_create_acceptance_status smallint;
ALTER TABLE reference_attempts ADD COLUMN IF NOT EXISTS caldav_create_acceptance_status smallint;
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_caldav_create_acceptance_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_caldav_create_acceptance_check CHECK (
  caldav_create_acceptance_status IS NULL OR provider='caldav' AND action='create' AND caldav_create_acceptance_status IN (200,201,204)
);
ALTER TABLE reference_attempts DROP CONSTRAINT IF EXISTS reference_attempts_caldav_create_acceptance_check;
ALTER TABLE reference_attempts ADD CONSTRAINT reference_attempts_caldav_create_acceptance_check CHECK (
  caldav_create_acceptance_status IS NULL OR caldav_create_acceptance_status IN (200,201,204)
);
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_provider_profile_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_provider_profile_check CHECK (
  provider='google' AND endpoint_profile='google-personal-event-'||action||'-v1' OR
  provider='microsoft' AND action IN ('create','delete') AND endpoint_profile='microsoft-personal-event-'||action||'-v1' OR
  provider='caldav' AND action IN ('create','delete') AND endpoint_profile='caldav-personal-event-'||action||'-v1'
);
ALTER TABLE reference_bindings DROP CONSTRAINT IF EXISTS reference_bindings_create_reservation_check;
ALTER TABLE reference_bindings ADD CONSTRAINT reference_bindings_create_reservation_check CHECK (
  (create_operation_id IS NULL OR create_operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
  ((create_operation_id IS NULL) = (create_profile IS NULL)) AND
  (create_profile IS NULL OR create_profile IN ('google-personal-event-create-v1','microsoft-personal-event-create-v1','caldav-personal-event-create-v1')) AND
  CASE WHEN destination_lifecycle='reserved' THEN
    create_operation_id IS NOT NULL AND etag IS NULL AND baseline IS NULL AND
    CASE WHEN create_profile='microsoft-personal-event-create-v1' THEN event_id IS NULL
      WHEN create_profile='caldav-personal-event-create-v1' THEN event_id IS NOT NULL AND ical_uid IS NOT NULL
      ELSE event_id IS NOT NULL AND event_id='musubi'||replace(create_operation_id,'-','') END
  ELSE event_id IS NOT NULL AND length(event_id)>0 AND baseline IS NOT NULL AND
    CASE WHEN create_profile='microsoft-personal-event-create-v1' THEN
      etag IS NULL OR length(etag)<=2048 AND etag ~ ('^W/"[!#-~'||chr(128)||'-'||chr(255)||']+"$')
    ELSE etag IS NOT NULL END END
);
-- This named constraint is also the installed-version marker consumed by the
-- earlier Graph migration. It protects DAV identity before and after adoption.
ALTER TABLE reference_bindings DROP CONSTRAINT IF EXISTS reference_bindings_caldav_create_identity_check;
ALTER TABLE reference_bindings ADD CONSTRAINT reference_bindings_caldav_create_identity_check CHECK (
  create_profile IS DISTINCT FROM 'caldav-personal-event-create-v1' OR
  create_operation_id IS NOT NULL AND event_id IS NOT NULL AND ical_uid IS NOT NULL AND
  ical_uid='musubi-'||create_operation_id AND
  event_id=(CASE WHEN right(calendar_id,1)='/' THEN calendar_id ELSE calendar_id||'/' END)||ical_uid||'.ics' AND
  (destination_lifecycle='reserved' OR etag IS NOT NULL AND etag ~ ('^"[!#-~'||chr(128)||'-'||chr(255)||']*"$'))
);
ALTER TABLE reference_operations DROP CONSTRAINT IF EXISTS reference_operations_caldav_create_identity_check;
ALTER TABLE reference_operations ADD CONSTRAINT reference_operations_caldav_create_identity_check CHECK (
  provider<>'caldav' OR action<>'create' OR
  id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND accepted_uid IS NOT NULL AND
  accepted_uid='musubi-'||id AND event_id IS NOT NULL AND
  event_id=(CASE WHEN right(calendar_id,1)='/' THEN calendar_id ELSE calendar_id||'/' END)||accepted_uid||'.ics' AND accepted_etag IS NULL
);
