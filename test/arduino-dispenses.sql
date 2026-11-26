-- Run with psql -v ON_ERROR_STOP=1 -f test/arduino-dispenses.sql against a migrated test database.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;

DO $$
DECLARE
  d uuid := gen_random_uuid();
  e uuid := gen_random_uuid();
  enrollment uuid := gen_random_uuid();
  event jsonb;
  guest jsonb;
BEGIN
  ASSERT has_function_privilege('service_role', 'commit_arduino_dispense(jsonb)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'commit_arduino_dispense(jsonb)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'commit_arduino_dispense(jsonb)', 'EXECUTE');
  INSERT INTO devices (id) VALUES (d);
  event := jsonb_build_object('device_id', d, 'event_id', e, 'recognized_user_id', enrollment,
    'start_ts', '2026-11-26T10:00:00.123456Z', 'end_ts', '2026-11-26T10:00:00.123457Z',
    'volume_ml', 2.25, 'tds_ppm', 82.35);

  ASSERT commit_arduino_dispense(event) = 'committed';
  ASSERT commit_arduino_dispense(event) = 'committed';
  ASSERT commit_arduino_dispense(event || '{"volume_ml":2.26}') = 'conflict';
  ASSERT commit_arduino_dispense(event || '{"recognized_user_id":null}') = 'conflict';
  ASSERT commit_arduino_dispense(event || jsonb_build_object('device_id', gen_random_uuid())) = 'unknown_device';
  ASSERT (SELECT count(*) FROM dispense_sessions WHERE device_id = d AND event_id = e) = 1;
  ASSERT (SELECT count(*) FROM edge_receipts WHERE device_id = d AND event_id = e) = 1;
  ASSERT EXISTS (SELECT FROM dispense_sessions WHERE device_id = d AND event_id = e
    AND recognized_user_id = enrollment AND user_id IS NULL AND volume_ml = 2.25
    AND avg_tds_out = 82.35 AND temperature_c IS NULL AND tds_in IS NULL
    AND ph_approx IS NULL AND pulse_count IS NULL AND sensor_quality IS NULL
    AND end_ts - start_ts = interval '1 microsecond');
  ASSERT (SELECT payload->>'recognized_user_id' FROM edge_events
    WHERE device_id = d AND event_id = e) = enrollment::text;

  guest := event || jsonb_build_object('event_id', gen_random_uuid())
    || '{"recognized_user_id":null,"tds_ppm":null}';
  ASSERT commit_arduino_dispense(guest) = 'committed';
  ASSERT EXISTS (SELECT FROM dispense_sessions WHERE device_id = d
    AND event_id = (guest->>'event_id')::uuid AND recognized_user_id IS NULL
    AND user_id IS NULL AND avg_tds_out IS NULL);
END;
$$;

ROLLBACK;
