BEGIN;

DROP VIEW public.dashboard_summary;
ALTER TABLE public.devices
  ADD COLUMN tank_state text NOT NULL DEFAULT 'UNKNOWN' CHECK (tank_state IN ('LOW','OK','UNKNOWN')),
  ADD COLUMN telemetry jsonb,
  ALTER COLUMN tank_level_ml DROP DEFAULT,
  ALTER COLUMN current_tds DROP DEFAULT,
  ALTER COLUMN filter_life_liters DROP DEFAULT;
-- The legacy snapshot lacks the validity metadata required by version 1.
UPDATE public.devices SET last_telemetry_at = NULL, status = 'offline',
  tank_level_ml = NULL, current_tds = NULL, filter_life_liters = NULL;

ALTER TABLE public.dispense_sessions
  DROP CONSTRAINT dispense_sessions_volume_ml_check,
  ALTER COLUMN volume_ml TYPE numeric,
  ALTER COLUMN avg_tds_out TYPE numeric,
  ADD CHECK (volume_ml >= 0),
  ADD COLUMN event_id uuid,
  ADD COLUMN revision integer,
  ADD COLUMN pulse_count bigint,
  ADD COLUMN tds_in numeric,
  ADD COLUMN ph_approx numeric,
  ADD COLUMN sensor_quality jsonb,
  ADD COLUMN confidence numeric,
  ADD COLUMN recognition_status text,
  ADD COLUMN volume_quality text,
  ADD COLUMN incomplete boolean,
  ADD COLUMN quality_flags jsonb,
  ADD UNIQUE (device_id, event_id);

CREATE VIEW public.dashboard_summary WITH (security_invoker = true) AS
SELECT d.id AS device_id, d.name, d.status, d.tank_state, d.telemetry,
       d.firmware_version, d.last_seen_at,
       usage.water_consumed_today_ml, usage.water_consumed_week_ml,
       usage.session_count_today, usage.filter_usage_ml
FROM public.devices d
CROSS JOIN LATERAL (
  SELECT coalesce(sum(volume_ml) FILTER (WHERE start_ts >= CURRENT_DATE), 0) AS water_consumed_today_ml,
         coalesce(sum(volume_ml) FILTER (WHERE start_ts >= date_trunc('week', now())), 0) AS water_consumed_week_ml,
         count(*) FILTER (WHERE start_ts >= CURRENT_DATE) AS session_count_today,
         coalesce(sum(volume_ml) FILTER (WHERE volume_quality = 'measured'), 0) AS filter_usage_ml
  FROM public.dispense_sessions s WHERE s.device_id = d.id
) usage;
GRANT SELECT ON public.dashboard_summary TO authenticated, service_role;

DROP POLICY IF EXISTS "Members can insert commands for their devices" ON public.command_logs;
DROP POLICY IF EXISTS "Users can insert commands for their devices" ON public.command_logs;
REVOKE INSERT, UPDATE, DELETE ON public.command_logs FROM PUBLIC, anon, authenticated;
ALTER TABLE public.command_logs
  DROP CONSTRAINT command_logs_status_check,
  ADD CHECK (status IN ('pending','delivered','received','accepted','rejected','running','completed','failed')),
  ADD COLUMN idempotency_key text,
  ADD COLUMN duration_s numeric,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN broker_delivered_at timestamptz,
  ADD COLUMN next_dispatch_at timestamptz,
  ADD UNIQUE (device_id, issued_by, idempotency_key);

CREATE TABLE public.edge_events (
  device_id uuid REFERENCES public.devices ON DELETE CASCADE,
  event_id uuid,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (device_id, event_id)
);
CREATE TABLE public.edge_receipts (
  device_id uuid,
  event_id uuid,
  revision integer CHECK (revision > 0),
  payload_hash bytea NOT NULL,
  PRIMARY KEY (device_id, event_id, revision),
  FOREIGN KEY (device_id, event_id) REFERENCES public.edge_events ON DELETE CASCADE
);
CREATE TABLE public.command_history (
  command_id uuid REFERENCES public.command_logs ON DELETE CASCADE,
  revision integer,
  status text NOT NULL,
  reason text NOT NULL,
  timestamp timestamptz NOT NULL,
  valve_state text NOT NULL,
  PRIMARY KEY (command_id, revision)
);
CREATE TABLE public.edge_alert_state (
  device_id uuid REFERENCES public.devices ON DELETE CASCADE,
  name text,
  active boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, name)
);
CREATE TABLE public.notification_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE
);
CREATE TABLE public.alert_outbox (
  device_id uuid,
  event_id uuid,
  revision integer,
  payload jsonb NOT NULL,
  expanded_at timestamptz,
  PRIMARY KEY (device_id, event_id, revision),
  FOREIGN KEY (device_id, event_id, revision) REFERENCES public.edge_receipts ON DELETE CASCADE
);
CREATE TABLE public.alert_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id uuid NOT NULL,
  event_id uuid NOT NULL,
  revision integer NOT NULL,
  token text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  FOREIGN KEY (device_id, event_id, revision) REFERENCES public.alert_outbox ON DELETE CASCADE,
  UNIQUE (device_id, event_id, revision, token)
);
CREATE INDEX alert_deliveries_due ON public.alert_deliveries (next_attempt_at) WHERE finished_at IS NULL;
CREATE INDEX alert_outbox_pending ON public.alert_outbox (device_id, event_id, revision) WHERE expanded_at IS NULL;
CREATE INDEX command_logs_due ON public.command_logs (next_dispatch_at) WHERE status = 'pending';

ALTER TABLE public.edge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.command_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_deliveries ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.edge_events, public.edge_receipts,
  public.command_history, public.edge_alert_state, public.notification_tokens,
  public.alert_outbox, public.alert_deliveries TO service_role;

CREATE FUNCTION public.commit_edge_event(p_kind text, p_payload jsonb) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  d uuid := (p_payload->>'device_id')::uuid;
  e uuid := (p_payload->>'event_id')::uuid;
  r integer := (p_payload->>'revision')::integer;
  hash bytea := sha256(convert_to(p_payload::text, 'UTF8'));
  previous edge_events;
  receipt bytea;
  command_row command_logs;
  next_status text := p_payload->>'status';
  identity_keys text[] := ARRAY['revision','user_id','confidence','recognition_status'];
  resolved_user_id uuid;
  alert edge_alert_state;
  alert_time timestamptz;
  alert_active boolean;
BEGIN
  IF p_kind NOT IN ('dispense', 'alert', 'command_ack') THEN RETURN 'invalid_kind'; END IF;
  PERFORM 1 FROM devices WHERE id = d FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_device'; END IF;

  SELECT payload_hash INTO receipt FROM edge_receipts
  WHERE device_id = d AND event_id = e AND revision = r;
  SELECT * INTO previous FROM edge_events WHERE device_id = d AND event_id = e;
  IF previous.kind IS NOT NULL AND previous.kind <> p_kind THEN RETURN 'conflict'; END IF;
  IF receipt IS NOT NULL THEN
    RETURN CASE WHEN receipt = hash THEN 'committed' ELSE 'conflict' END;
  END IF;
  IF r <> coalesce(previous.revision, 0) + 1 THEN RETURN 'revision_gap'; END IF;

  IF p_kind = 'command_ack' THEN
    SELECT * INTO command_row FROM command_logs
    WHERE id = e AND device_id = d AND issued_at IS NOT NULL FOR UPDATE;
    IF NOT FOUND OR p_payload->>'command_id' <> e::text THEN RETURN 'unknown_command'; END IF;
    IF NOT coalesce(CASE command_row.status
      WHEN 'pending' THEN next_status = 'received'
      WHEN 'received' THEN next_status IN ('accepted','rejected','failed')
      WHEN 'accepted' THEN next_status IN ('running','failed')
      WHEN 'running' THEN next_status IN ('completed','failed')
      ELSE false END, false) THEN RETURN 'invalid_transition'; END IF;
    INSERT INTO command_history VALUES (e, r, next_status, p_payload->>'reason',
      (p_payload->>'timestamp')::timestamptz, p_payload->>'valve_state');
    UPDATE command_logs SET status = next_status WHERE id = e;
  ELSIF p_kind = 'dispense' THEN
    IF r > 1 AND (p_payload - identity_keys) <> (previous.payload - identity_keys) THEN
      RETURN 'measurement_conflict';
    END IF;
    IF p_payload->>'user_id' <> 'guest' THEN
      SELECT user_id INTO resolved_user_id FROM device_members
      WHERE device_id = d AND user_id = (p_payload->>'user_id')::uuid;
    END IF;
    IF r = 1 THEN
      INSERT INTO dispense_sessions (id, device_id, event_id, revision, user_id, start_ts, end_ts,
        volume_ml, pulse_count, temperature_c, tds_in, avg_tds_out, ph_approx,
        sensor_quality, confidence, recognition_status, volume_quality, incomplete, quality_flags)
      VALUES (gen_random_uuid(), d, e, r, resolved_user_id, (p_payload->>'start_ts')::timestamptz,
        (p_payload->>'end_ts')::timestamptz, (p_payload->>'volume_ml')::numeric,
        (p_payload->>'pulse_count')::bigint, (p_payload->>'temperature_c')::numeric,
        (p_payload->>'tds_in')::numeric, (p_payload->>'tds_out')::numeric,
        (p_payload->>'ph_approx')::numeric, p_payload->'sensor_quality',
        (p_payload->>'confidence')::numeric, p_payload->>'recognition_status',
        p_payload->>'volume_quality', (p_payload->>'incomplete')::boolean, p_payload->'quality_flags');
    ELSE
      UPDATE dispense_sessions SET revision = r, user_id = resolved_user_id,
        recognition_status = p_payload->>'recognition_status', confidence = (p_payload->>'confidence')::numeric
      WHERE device_id = d AND event_id = e;
    END IF;
  END IF;

  INSERT INTO edge_events VALUES (d, e, r, p_kind, p_payload)
  ON CONFLICT (device_id, event_id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload;
  INSERT INTO edge_receipts VALUES (d, e, r, hash);

  IF p_kind = 'alert' THEN
    alert_time := (p_payload->>'timestamp')::timestamptz;
    alert_active := (p_payload->>'active')::boolean;
    SELECT * INTO alert FROM edge_alert_state WHERE device_id = d AND name = p_payload->>'name';
    IF alert.observed_at IS NULL OR alert_time >= alert.observed_at THEN
      INSERT INTO edge_alert_state VALUES (d, p_payload->>'name', alert_active, alert_time)
      ON CONFLICT (device_id, name) DO UPDATE SET active = excluded.active, observed_at = excluded.observed_at;
      IF alert_active <> coalesce(alert.active, false) THEN
        INSERT INTO alert_outbox (device_id, event_id, revision, payload) VALUES (d, e, r, p_payload);
      END IF;
    END IF;
  END IF;
  RETURN 'committed';
END;
$$;

CREATE FUNCTION public.request_drain(p_device uuid, p_owner uuid, p_key text,
  p_duration numeric, p_rate_ms integer, p_online_minutes numeric) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  device_row devices;
  command_row command_logs;
  issued timestamptz;
BEGIN
  SELECT * INTO device_row FROM devices WHERE id = p_device FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'DEVICE_NOT_FOUND'); END IF;
  PERFORM 1 FROM device_members WHERE device_id = p_device AND user_id = p_owner AND role = 'owner' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'DEVICE_OWNER_REQUIRED'); END IF;
  IF p_duration IS NULL OR NOT (p_duration > 0 AND p_duration <= 15) OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 128 THEN
    RETURN jsonb_build_object('error','INVALID_DRAIN');
  END IF;
  SELECT * INTO command_row FROM command_logs WHERE device_id = p_device AND issued_by = p_owner AND idempotency_key = p_key;
  IF FOUND THEN
    IF command_row.duration_s <> p_duration THEN RETURN jsonb_build_object('error','IDEMPOTENCY_CONFLICT'); END IF;
  ELSE
    issued := clock_timestamp();
    IF device_row.status = 'offline' OR device_row.last_seen_at IS NULL OR
       device_row.last_seen_at < issued - p_online_minutes * interval '1 minute' THEN
      RETURN jsonb_build_object('error','DEVICE_OFFLINE');
    END IF;
    IF device_row.status IN ('dispensing','flushing') THEN RETURN jsonb_build_object('error','DEVICE_BUSY'); END IF;
    IF EXISTS (SELECT 1 FROM command_logs WHERE device_id = p_device
       AND (created_at > issued - p_rate_ms * interval '1 millisecond'
            OR (status = 'pending' AND expires_at > issued))) THEN
      RETURN jsonb_build_object('error','COMMAND_RATE_LIMITED');
    END IF;
    INSERT INTO command_logs (device_id, issued_by, command, status, idempotency_key, duration_s,
      issued_at, expires_at, next_dispatch_at, created_at)
    VALUES (p_device, p_owner, 'drain', 'pending', p_key, p_duration,
      issued, issued + interval '15 seconds', issued, issued) RETURNING * INTO command_row;
  END IF;
  RETURN jsonb_build_object('command_id', command_row.id, 'status', command_row.status);
END;
$$;

CREATE FUNCTION public.claim_drain_dispatch() RETURNS SETOF public.command_logs
LANGUAGE sql SET search_path = public AS $$
  WITH due AS (
    SELECT id FROM command_logs WHERE status = 'pending' AND expires_at > clock_timestamp()
      AND next_dispatch_at <= clock_timestamp() ORDER BY next_dispatch_at
      LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE command_logs SET next_dispatch_at = clock_timestamp() + interval '3 seconds'
  FROM due WHERE command_logs.id = due.id RETURNING command_logs.*;
$$;

CREATE FUNCTION public.claim_alert_delivery()
RETURNS TABLE (id bigint, token text, attempts integer, payload jsonb)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE job alert_outbox;
BEGIN
  SELECT * INTO job FROM alert_outbox WHERE expanded_at IS NULL
    LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    INSERT INTO alert_deliveries (device_id, event_id, revision, token, user_id)
    SELECT job.device_id, job.event_id, job.revision, t.token, t.user_id
    FROM notification_tokens t JOIN device_members m USING (user_id) WHERE m.device_id = job.device_id
    ON CONFLICT DO NOTHING;
    UPDATE alert_outbox o SET expanded_at = now()
    WHERE (o.device_id, o.event_id, o.revision) = (job.device_id, job.event_id, job.revision);
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT a.id FROM alert_deliveries a WHERE a.finished_at IS NULL AND a.next_attempt_at <= now()
    ORDER BY a.next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE alert_deliveries a SET next_attempt_at = now() + interval '60 seconds', attempts = a.attempts + 1
    FROM due WHERE a.id = due.id RETURNING a.*
  )
  SELECT a.id, CASE WHEN EXISTS (SELECT 1 FROM device_members m JOIN notification_tokens t USING (user_id)
    WHERE m.device_id = a.device_id AND m.user_id = a.user_id AND t.token = a.token) THEN a.token END,
    a.attempts, o.payload
  FROM claimed a JOIN alert_outbox o USING (device_id, event_id, revision);
END;
$$;

CREATE FUNCTION public.finish_alert_delivery(p_id bigint, p_attempts integer, p_outcome text)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE delivery alert_deliveries;
BEGIN
  UPDATE alert_deliveries SET finished_at = now(), outcome = p_outcome
  WHERE id = p_id AND attempts = p_attempts AND finished_at IS NULL RETURNING * INTO delivery;
  IF FOUND AND p_outcome = 'invalid_token' THEN
    DELETE FROM notification_tokens WHERE token = delivery.token AND user_id = delivery.user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_alert_delivery(bigint,integer,text), public.commit_edge_event(text,jsonb),
  public.request_drain(uuid,uuid,text,numeric,integer,numeric),
  public.claim_drain_dispatch(), public.claim_alert_delivery() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_alert_delivery(bigint,integer,text), public.commit_edge_event(text,jsonb),
  public.request_drain(uuid,uuid,text,numeric,integer,numeric),
  public.claim_drain_dispatch(), public.claim_alert_delivery() TO service_role;

COMMIT;
