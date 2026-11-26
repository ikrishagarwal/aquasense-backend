BEGIN;

CREATE TABLE public.device_enrollment_links (
  device_id uuid NOT NULL,
  recognized_user_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (device_id, recognized_user_id),
  FOREIGN KEY (device_id, user_id)
    REFERENCES public.device_members (device_id, user_id) ON DELETE CASCADE
);

ALTER TABLE public.device_enrollment_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_enrollment_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.device_enrollment_links TO service_role;

CREATE INDEX device_enrollment_links_member_idx
  ON public.device_enrollment_links (device_id, user_id);

-- Include legacy sessions that predate the incomplete flag.
CREATE INDEX dispense_sessions_completed_page_idx
  ON public.dispense_sessions (device_id, start_ts DESC, id DESC)
  WHERE incomplete IS NOT TRUE;

CREATE INDEX dispense_sessions_completed_tds_idx
  ON public.dispense_sessions (device_id, end_ts DESC, id DESC)
  WHERE incomplete IS NOT TRUE AND avg_tds_out IS NOT NULL;

-- A NULL return means that the authenticated account has no device membership.
CREATE FUNCTION public.read_drinking_log(
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
        SELECT s.id, s.start_ts, s.end_ts, s.volume_ml, s.avg_tds_out AS tds_ppm
        FROM public.dispense_sessions AS s
        LEFT JOIN public.device_enrollment_links AS link
          ON s.user_id IS NULL
          AND link.device_id = s.device_id
          AND link.recognized_user_id = s.recognized_user_id
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

REVOKE ALL ON FUNCTION public.read_drinking_log(uuid, uuid, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_drinking_log(uuid, uuid, timestamptz, uuid, integer)
  TO service_role;

COMMIT;
