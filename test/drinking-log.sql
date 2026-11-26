-- Run with psql -v ON_ERROR_STOP=1 -f test/drinking-log.sql against a migrated test database.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;

DO $$
DECLARE
  device uuid := gen_random_uuid();
  other_device uuid := gen_random_uuid();
  account uuid := gen_random_uuid();
  other_account uuid := gen_random_uuid();
  enrollment uuid := gen_random_uuid();
  older_id uuid := '10000000-0000-4000-8000-000000000001';
  matched_id uuid := '10000000-0000-4000-8000-000000000002';
  assigned_id uuid := gen_random_uuid();
  tied_start timestamptz := '2026-11-26T10:00:00.123456Z';
  latest_end timestamptz := '2026-11-26T11:00:00Z';
  result jsonb;
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'device_enrollment_links'::regclass);
  ASSERT has_table_privilege('service_role', 'device_enrollment_links', 'SELECT');
  ASSERT NOT has_table_privilege('authenticated', 'device_enrollment_links', 'SELECT, INSERT, UPDATE, DELETE');
  ASSERT NOT has_table_privilege('anon', 'device_enrollment_links', 'SELECT, INSERT, UPDATE, DELETE');
  ASSERT has_function_privilege('service_role', 'read_drinking_log(uuid,uuid,timestamptz,uuid,integer)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'read_drinking_log(uuid,uuid,timestamptz,uuid,integer)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'read_drinking_log(uuid,uuid,timestamptz,uuid,integer)', 'EXECUTE');

  INSERT INTO auth.users (id, email)
  VALUES (account, account || '@example.invalid'), (other_account, other_account || '@example.invalid');
  INSERT INTO devices (id) VALUES (device), (other_device);
  INSERT INTO device_members (device_id, user_id)
  VALUES (device, account), (device, other_account), (other_device, account);
  INSERT INTO dispense_sessions (
    id, device_id, user_id, recognized_user_id, start_ts, end_ts, volume_ml, avg_tds_out, incomplete
  ) VALUES
    (older_id, device, account, NULL, tied_start, tied_start, 30, 50, NULL),
    (matched_id, device, NULL, enrollment, tied_start, tied_start, 20.25, NULL, false),
    (assigned_id, device, other_account, enrollment, tied_start, tied_start, 40, 60, false),
    (gen_random_uuid(), device, NULL, NULL, tied_start, latest_end, 50, 0, false),
    (gen_random_uuid(), device, NULL, enrollment, latest_end, latest_end + interval '1 second', 60, NULL, false),
    (gen_random_uuid(), device, account, enrollment, latest_end, latest_end + interval '2 seconds', 70, 90, true),
    (gen_random_uuid(), other_device, NULL, enrollment, latest_end, latest_end, 80, NULL, false),
    (gen_random_uuid(), other_device, account, NULL, latest_end, latest_end, 90, NULL, false);

  result := read_drinking_log(device, account, NULL, NULL, 25);
  ASSERT jsonb_array_length(result->'sessions') = 1;
  ASSERT (result #>> '{sessions,0,id}')::uuid = older_id;
  ASSERT (result #>> '{latest_tds,tds_ppm}')::numeric = 0;
  ASSERT (result #>> '{latest_tds,end_ts}')::timestamptz = latest_end;
  ASSERT read_drinking_log(other_device, other_account, NULL, NULL, 25) IS NULL;

  BEGIN
    INSERT INTO device_enrollment_links VALUES (other_device, enrollment, other_account);
    RAISE EXCEPTION 'Link unexpectedly allowed for a non-member';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  INSERT INTO device_enrollment_links VALUES (device, enrollment, account);

  SET LOCAL ROLE service_role;
  result := read_drinking_log(device, account, NULL, NULL, 25);
  RESET ROLE;
  ASSERT jsonb_array_length(result->'sessions') = 3;
  ASSERT (result #>> '{sessions,1,id}')::uuid = matched_id;
  ASSERT (result #>> '{sessions,1,volume_ml}')::numeric = 20.25;
  ASSERT result #> '{sessions,1,tds_ppm}' = 'null'::jsonb;
  ASSERT (result #>> '{sessions,2,id}')::uuid = older_id;
  ASSERT (result #>> '{latest_tds,tds_ppm}')::numeric = 0;

  -- The SQL function returns one extra row so the API can detect another page.
  result := read_drinking_log(device, account, NULL, NULL, 2);
  ASSERT jsonb_array_length(result->'sessions') = 3;
  result := read_drinking_log(device, account, tied_start, matched_id, 2);
  ASSERT jsonb_array_length(result->'sessions') = 1;
  ASSERT (result #>> '{sessions,0,id}')::uuid = older_id;
  ASSERT (result #>> '{latest_tds,end_ts}')::timestamptz = latest_end;

  result := read_drinking_log(device, other_account, NULL, NULL, 25);
  ASSERT jsonb_array_length(result->'sessions') = 1;
  ASSERT (result #>> '{sessions,0,id}')::uuid = assigned_id;
  ASSERT (result #>> '{latest_tds,tds_ppm}')::numeric = 0;

  result := read_drinking_log(other_device, account, NULL, NULL, 25);
  ASSERT jsonb_array_length(result->'sessions') = 1;
  ASSERT result->'latest_tds' = 'null'::jsonb;

  DELETE FROM device_members WHERE device_id = device AND user_id = account;
  ASSERT NOT EXISTS (SELECT FROM device_enrollment_links WHERE device_id = device);
  ASSERT read_drinking_log(device, account, NULL, NULL, 25) IS NULL;
END;
$$;

ROLLBACK;
