-- Run with psql -v ON_ERROR_STOP=1 -f test/edge-v1.sql against a migrated test database.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;

DO $$
DECLARE
  d uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  event jsonb;
  lifecycle jsonb;
  alert jsonb;
  cmd jsonb;
  i integer;
  outsider_id uuid := gen_random_uuid();
  delivery record;
BEGIN
  INSERT INTO auth.users (id,email) VALUES (owner_id, owner_id || '@example.invalid'),
    (member_id, member_id || '@example.invalid'), (outsider_id, outsider_id || '@example.invalid');
  ASSERT NOT has_table_privilege('authenticated', 'command_logs', 'INSERT');
  ASSERT NOT has_function_privilege('authenticated', 'commit_edge_event(text,jsonb)', 'EXECUTE');
  INSERT INTO devices (id, status) VALUES (d, 'online');
  INSERT INTO device_members (device_id,user_id,role) VALUES (d,owner_id,'owner'), (d,member_id,'member');
  event := jsonb_build_object('schema_version',1,'device_id',d,'revision',1,'user_id','guest',
    'start_ts','2026-11-01T00:00:00Z','end_ts','2026-11-01T00:00:00Z','volume_ml',2.25,
    'volume_quality','measured','pulse_count',1,'tds_out',NULL,'temperature_c',NULL);
  FOR i IN 1..10 LOOP
    event := event || jsonb_build_object('event_id',gen_random_uuid());
    ASSERT commit_edge_event('dispense', event) = 'committed';
    ASSERT commit_edge_event('dispense', event) = 'committed';
  END LOOP;
  ASSERT (SELECT count(*) FROM dispense_sessions WHERE device_id = d) = 10;
  ASSERT (SELECT filter_usage_ml FROM dashboard_summary WHERE device_id = d) = 22.5;
  ASSERT (SELECT count(*) FROM dispense_sessions WHERE device_id = d
    AND user_id IS NULL AND avg_tds_out IS NULL AND temperature_c IS NULL) = 10;
  ASSERT commit_edge_event('dispense', event || '{"volume_ml":3}') = 'conflict';
  ASSERT commit_edge_event('dispense', event || '{"revision":3}') = 'revision_gap';
  ASSERT commit_edge_event('dispense', event || '{"revision":2,"volume_ml":3}') = 'measurement_conflict';
  ASSERT commit_edge_event('dispense', event || jsonb_build_object('revision',2,'user_id',member_id)) = 'committed';
  ASSERT commit_edge_event('dispense', event) = 'committed';
  ASSERT commit_edge_event('dispense', event || '{"volume_ml":3}') = 'conflict';
  ASSERT (SELECT user_id FROM dispense_sessions WHERE device_id = d AND event_id = (event->>'event_id')::uuid) = member_id;
  ASSERT commit_edge_event('dispense', event || jsonb_build_object('device_id',gen_random_uuid())) = 'unknown_device';
  BEGIN
    PERFORM commit_edge_event('dispense', event || jsonb_build_object('event_id',gen_random_uuid()));
    RAISE EXCEPTION 'roll back simulated transaction' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM dispense_sessions WHERE device_id = d) = 10;
  ASSERT (SELECT count(*) FROM edge_receipts WHERE device_id = d) = 11;

  ASSERT request_drain(d,member_id,'fixture',5,10000,5)->>'error' = 'DEVICE_OWNER_REQUIRED';
  cmd := request_drain(d,owner_id,'fixture',5,10000,5);
  ASSERT cmd->>'status' = 'pending';
  ASSERT request_drain(d,owner_id,'fixture',5,10000,5) = cmd;
  ASSERT request_drain(d,owner_id,'fixture',6,10000,5)->>'error' = 'IDEMPOTENCY_CONFLICT';
  ASSERT request_drain(d,owner_id,'new-key',5,10000,5)->>'error' = 'COMMAND_RATE_LIMITED';
  ASSERT EXISTS (SELECT FROM claim_drain_dispatch() WHERE id = (cmd->>'command_id')::uuid);
  lifecycle := jsonb_build_object('schema_version',1,'device_id',d,'event_id',cmd->>'command_id',
    'command_id',cmd->>'command_id','type','command_ack','reason','actuation_disabled',
    'valve_state','commanded_closed','timestamp',now());
  ASSERT commit_edge_event('command_ack', lifecycle || '{"revision":2,"status":"rejected"}') = 'revision_gap';
  ASSERT commit_edge_event('command_ack', lifecycle || '{"revision":1,"status":"received"}') = 'committed';
  ASSERT commit_edge_event('command_ack', lifecycle || '{"revision":2,"status":"rejected"}') = 'committed';
  ASSERT commit_edge_event('command_ack', lifecycle || '{"revision":1,"status":"received"}') = 'committed';
  ASSERT commit_edge_event('command_ack', lifecycle || '{"revision":3,"status":"accepted"}') = 'invalid_transition';
  ASSERT (SELECT status FROM command_logs WHERE id = (cmd->>'command_id')::uuid) = 'rejected';
  ASSERT NOT EXISTS (SELECT FROM claim_drain_dispatch() WHERE id = (cmd->>'command_id')::uuid);

  INSERT INTO notification_tokens VALUES ('test-' || owner_id, owner_id), ('test-' || outsider_id, outsider_id);
  alert := jsonb_build_object('schema_version',1,'device_id',d,'event_id',gen_random_uuid(),
    'revision',1,'type','alert','name','outlet_tds_high','active',true,'timestamp',now());
  ASSERT commit_edge_event('alert', alert) = 'committed';
  ASSERT commit_edge_event('alert', alert) = 'committed';
  ASSERT commit_edge_event('alert', alert || jsonb_build_object('event_id',gen_random_uuid())) = 'committed';
  ASSERT (SELECT count(*) FROM alert_outbox WHERE device_id = d) = 1;
  SELECT * INTO delivery FROM claim_alert_delivery();
  ASSERT delivery.token = 'test-' || owner_id;
  ASSERT NOT EXISTS (SELECT FROM claim_alert_delivery());
  UPDATE alert_deliveries SET next_attempt_at = now() WHERE id = delivery.id;
  SELECT * INTO delivery FROM claim_alert_delivery();
  ASSERT delivery.attempts = 2;
  PERFORM finish_alert_delivery(delivery.id, delivery.attempts, 'invalid_token');
  ASSERT NOT EXISTS (SELECT FROM notification_tokens WHERE user_id = owner_id);
  ASSERT (SELECT outcome FROM alert_deliveries WHERE id = delivery.id) = 'invalid_token';
END;
$$;
ROLLBACK;
