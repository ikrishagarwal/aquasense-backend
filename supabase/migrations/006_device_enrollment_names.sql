BEGIN;

CREATE TABLE public.device_enrollment_names (
  device_id uuid NOT NULL REFERENCES public.devices (id) ON DELETE CASCADE,
  recognized_user_id uuid NOT NULL,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) > 0),
  PRIMARY KEY (device_id, recognized_user_id)
);

ALTER TABLE public.device_enrollment_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_enrollment_names FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.device_enrollment_names TO service_role;

-- A NULL return means that the authenticated account has no device membership.
CREATE OR REPLACE FUNCTION public.read_drinking_log(
  p_device_id uuid,
  p_user_id uuid,
  p_before_start timestamptz,
  p_before_id uuid,
  p_limit integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'sessions', (
      SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.start_ts DESC, page.id DESC), '[]'::jsonb)
      FROM (
        SELECT s.id, s.start_ts, s.end_ts, s.volume_ml, s.avg_tds_out AS tds_ppm,
               s.recognized_user_id, enrollment.display_name AS recognized_user_name
        FROM public.dispense_sessions AS s
        LEFT JOIN public.device_enrollment_links AS link
          ON s.user_id IS NULL
          AND link.device_id = s.device_id
          AND link.recognized_user_id = s.recognized_user_id
        LEFT JOIN public.device_enrollment_names AS enrollment
          ON enrollment.device_id = s.device_id
          AND enrollment.recognized_user_id = s.recognized_user_id
        WHERE s.device_id = p_device_id
          AND s.incomplete IS NOT TRUE
          AND coalesce(s.user_id, link.user_id) = p_user_id
          AND (p_before_start IS NULL OR (s.start_ts, s.id) < (p_before_start, p_before_id))
        ORDER BY s.start_ts DESC, s.id DESC
        LIMIT (least(greatest(p_limit, 1), 100) + 1)
      ) AS page
    ),
    'latest_tds', (
      SELECT jsonb_build_object('tds_ppm', s.avg_tds_out, 'end_ts', s.end_ts)
      FROM public.dispense_sessions AS s
      WHERE s.device_id = p_device_id
        AND s.incomplete IS NOT TRUE
        AND s.avg_tds_out IS NOT NULL
      ORDER BY s.end_ts DESC, s.id DESC
      LIMIT 1
    )
  )
  WHERE public.is_device_member(p_device_id, p_user_id);
$$;

COMMIT;
