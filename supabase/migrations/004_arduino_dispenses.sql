BEGIN;

ALTER TABLE public.dispense_sessions ADD COLUMN recognized_user_id uuid;

CREATE FUNCTION public.commit_arduino_dispense(p_dispense jsonb) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  recognized_id uuid := (p_dispense->>'recognized_user_id')::uuid;
  outcome text;
BEGIN
  outcome := commit_edge_event('dispense', (p_dispense - 'tds_ppm') || jsonb_build_object(
    'schema_version', 1,
    'revision', 1,
    'user_id', 'guest',
    'recognition_status', CASE WHEN recognized_id IS NULL THEN 'unknown' ELSE 'matched' END,
    'volume_quality', 'measured',
    'incomplete', false,
    'tds_out', p_dispense->'tds_ppm'
  ));
  IF outcome = 'committed' AND recognized_id IS NOT NULL THEN
    UPDATE dispense_sessions SET recognized_user_id = recognized_id
    WHERE device_id = (p_dispense->>'device_id')::uuid
      AND event_id = (p_dispense->>'event_id')::uuid
      AND recognized_user_id IS DISTINCT FROM recognized_id;
  END IF;
  RETURN outcome;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_arduino_dispense(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_arduino_dispense(jsonb) TO service_role;

COMMIT;
