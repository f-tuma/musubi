-- Forward-only Task DELETE. Eight previous event/task profiles retain history,
-- admission payloads, native validators, epochs, table/index identities.
ALTER TABLE reference_task_bindings ADD COLUMN IF NOT EXISTS destination_lifecycle text NOT NULL DEFAULT 'present'
  CHECK(destination_lifecycle IN ('present','absent'));
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS delete_accepted_baseline jsonb;
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS delete_acceptance_status smallint;
ALTER TABLE reference_task_attempts ADD COLUMN IF NOT EXISTS delete_acceptance_status smallint;
ALTER TABLE reference_task_operations ADD COLUMN IF NOT EXISTS delete_response_absence_status smallint;
ALTER TABLE reference_task_attempts ADD COLUMN IF NOT EXISTS delete_response_absence_status smallint;
ALTER TABLE reference_task_operations ALTER COLUMN saved_projection DROP NOT NULL;
ALTER TABLE reference_task_operations ALTER COLUMN field_mask DROP NOT NULL;
-- A populated later CREATE ledger must survive a complete migration rerun.
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='reference_task_bindings'::regclass AND conname='reference_task_bindings_create_reservation_check') THEN
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_action_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_action_check CHECK(action IN ('update','delete'));
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_endpoint_profile_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_endpoint_profile_check CHECK(
  action='update' AND endpoint_profile='google-task-update-v1' OR action='delete' AND endpoint_profile='google-task-delete-v1'
);
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_delete_capture_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_delete_capture_check CHECK(
  action='update' AND saved_projection IS NOT NULL AND field_mask IS NOT NULL AND delete_accepted_baseline IS NULL AND
    delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL OR
  action='delete' AND saved_projection IS NULL AND field_mask IS NULL AND delete_accepted_baseline IS NOT NULL AND jsonb_typeof(delete_accepted_baseline)='object' AND native_acceptance_status IS NULL
);
END IF;
END $$;
ALTER TABLE reference_task_operations DROP CONSTRAINT IF EXISTS reference_task_operations_delete_response_check;
ALTER TABLE reference_task_operations ADD CONSTRAINT reference_task_operations_delete_response_check CHECK(
  (delete_acceptance_status IS NULL OR delete_acceptance_status BETWEEN 200 AND 299) AND
  (delete_response_absence_status IS NULL OR delete_response_absence_status IN (404,410))
);
ALTER TABLE reference_task_attempts DROP CONSTRAINT IF EXISTS reference_task_attempts_delete_response_check;
ALTER TABLE reference_task_attempts ADD CONSTRAINT reference_task_attempts_delete_response_check CHECK(
  (delete_acceptance_status IS NULL OR delete_acceptance_status BETWEEN 200 AND 299) AND
  (delete_response_absence_status IS NULL OR delete_response_absence_status IN (404,410)) AND
  (native_acceptance_status IS NULL OR delete_acceptance_status IS NULL AND delete_response_absence_status IS NULL)
);
-- Native absence is a delivery result, not grant retirement. The existing
-- binding epoch trigger intentionally advances only on active/grant changes;
-- our present->absent ACK does not flip active or advance source_generation.
