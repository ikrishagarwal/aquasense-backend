-- AquaSense membership model and server-side helpers.
-- Apply after the base schema in SQL.md.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email TEXT;

INSERT INTO public.profiles (id, email, display_name, avatar_url)
SELECT
  users.id,
  users.email,
  COALESCE(users.raw_user_meta_data ->> 'display_name', users.raw_user_meta_data ->> 'name'),
  users.raw_user_meta_data ->> 'avatar_url'
FROM auth.users AS users
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email
  WHERE public.profiles.email IS DISTINCT FROM EXCLUDED.email;

CREATE INDEX IF NOT EXISTS profiles_email_idx
  ON public.profiles (lower(email));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', NEW.raw_user_meta_data ->> 'name'),
    NEW.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email
    WHERE public.profiles.email IS DISTINCT FROM EXCLUDED.email;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE IF NOT EXISTS public.device_members (
  device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, user_id)
);

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS last_telemetry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS device_members_user_id_idx
  ON public.device_members (user_id);

CREATE OR REPLACE FUNCTION public.is_device_member(
  requested_device_id UUID,
  requested_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.device_members AS members
    WHERE members.device_id = requested_device_id
      AND members.user_id = requested_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_device_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_device_member(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_device_owner(
  requested_device_id UUID,
  requested_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.device_members AS members
    WHERE members.device_id = requested_device_id
      AND members.user_id = requested_user_id
      AND members.role = 'owner'
  );
$$;

REVOKE ALL ON FUNCTION public.is_device_owner(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_device_owner(UUID, UUID) TO authenticated, service_role;

INSERT INTO public.device_members (device_id, user_id, role)
SELECT devices.id, devices.owner_id, 'owner'
FROM public.devices AS devices
WHERE devices.owner_id IS NOT NULL
ON CONFLICT (device_id, user_id) DO UPDATE
  SET role = 'owner';

CREATE INDEX IF NOT EXISTS dispense_sessions_device_start_idx
  ON public.dispense_sessions (device_id, start_ts DESC);

CREATE INDEX IF NOT EXISTS dispense_sessions_guest_device_idx
  ON public.dispense_sessions (device_id)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS command_logs_device_created_idx
  ON public.command_logs (device_id, created_at DESC);

ALTER TABLE public.device_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Profiles are viewable by authenticated users" ON public.profiles;
CREATE POLICY "Profiles are viewable by authenticated users"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    auth.uid() = id
    OR EXISTS (
      SELECT 1
      FROM public.device_members AS members
      WHERE members.user_id = profiles.id
        AND public.is_device_member(members.device_id, auth.uid())
    )
  );
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can view their own devices" ON public.devices;
DROP POLICY IF EXISTS "Users can update their own devices" ON public.devices;
DROP POLICY IF EXISTS "Members can view devices" ON public.devices;
DROP POLICY IF EXISTS "Owners can update devices" ON public.devices;
CREATE POLICY "Members can view devices"
  ON public.devices FOR SELECT
  TO authenticated
  USING (public.is_device_member(id, auth.uid()));
CREATE POLICY "Owners can update devices"
  ON public.devices FOR UPDATE
  TO authenticated
  USING (public.is_device_owner(id, auth.uid()))
  WITH CHECK (public.is_device_owner(id, auth.uid()));

DROP POLICY IF EXISTS "Users can view sessions for their devices" ON public.dispense_sessions;
DROP POLICY IF EXISTS "Owners can reassign guest sessions" ON public.dispense_sessions;
DROP POLICY IF EXISTS "Members can view sessions for their devices" ON public.dispense_sessions;
CREATE POLICY "Members can view sessions for their devices"
  ON public.dispense_sessions FOR SELECT
  TO authenticated
  USING (public.is_device_member(device_id, auth.uid()));
CREATE POLICY "Owners can reassign guest sessions"
  ON public.dispense_sessions FOR UPDATE
  TO authenticated
  USING (public.is_device_owner(device_id, auth.uid()))
  WITH CHECK (public.is_device_owner(device_id, auth.uid()));

DROP POLICY IF EXISTS "Users can view commands for their devices" ON public.command_logs;
DROP POLICY IF EXISTS "Users can insert commands for their devices" ON public.command_logs;
DROP POLICY IF EXISTS "Members can view commands for their devices" ON public.command_logs;
DROP POLICY IF EXISTS "Members can insert commands for their devices" ON public.command_logs;
CREATE POLICY "Members can view commands for their devices"
  ON public.command_logs FOR SELECT
  TO authenticated
  USING (public.is_device_member(device_id, auth.uid()));
CREATE POLICY "Members can insert commands for their devices"
  ON public.command_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_device_member(device_id, auth.uid())
    AND issued_by = auth.uid()
  );

DROP POLICY IF EXISTS "Owners can view device members" ON public.device_members;
DROP POLICY IF EXISTS "Owners can add device members" ON public.device_members;
DROP POLICY IF EXISTS "Owners can edit device members" ON public.device_members;
DROP POLICY IF EXISTS "Owners can remove device members" ON public.device_members;
CREATE POLICY "Owners can view device members"
  ON public.device_members FOR SELECT
  TO authenticated
  USING (public.is_device_member(device_id, auth.uid()));
CREATE POLICY "Owners can add device members"
  ON public.device_members FOR INSERT
  TO authenticated
  WITH CHECK (public.is_device_owner(device_id, auth.uid()));
CREATE POLICY "Owners can edit device members"
  ON public.device_members FOR UPDATE
  TO authenticated
  USING (public.is_device_owner(device_id, auth.uid()))
  WITH CHECK (public.is_device_owner(device_id, auth.uid()));
CREATE POLICY "Owners can remove device members"
  ON public.device_members FOR DELETE
  TO authenticated
  USING (public.is_device_owner(device_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.set_command_log_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS command_logs_updated_at ON public.command_logs;
CREATE TRIGGER command_logs_updated_at
  BEFORE UPDATE ON public.command_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_command_log_updated_at();

CREATE OR REPLACE VIEW public.dashboard_summary
WITH (security_invoker = true)
AS
SELECT
  devices.id AS device_id,
  devices.name,
  devices.status,
  devices.tank_level_ml,
  devices.current_tds,
  devices.filter_life_liters,
  devices.firmware_version,
  devices.last_seen_at,
  COALESCE(
    (
      SELECT SUM(sessions.volume_ml)
      FROM public.dispense_sessions AS sessions
      WHERE sessions.device_id = devices.id
        AND sessions.start_ts >= CURRENT_DATE
    ),
    0
  )::BIGINT AS water_consumed_today_ml,
  COALESCE(
    (
      SELECT SUM(sessions.volume_ml)
      FROM public.dispense_sessions AS sessions
      WHERE sessions.device_id = devices.id
        AND sessions.start_ts >= DATE_TRUNC('week', NOW())
    ),
    0
  )::BIGINT AS water_consumed_week_ml,
  (
    SELECT COUNT(*)
    FROM public.dispense_sessions AS sessions
    WHERE sessions.device_id = devices.id
      AND sessions.start_ts >= CURRENT_DATE
  )::BIGINT AS session_count_today
FROM public.devices;

GRANT SELECT ON public.dashboard_summary TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_device(
  requested_device_id UUID,
  requesting_user_id UUID
)
RETURNS public.devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed_device public.devices;
BEGIN
  SELECT *
  INTO claimed_device
  FROM public.devices
  WHERE id = requested_device_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Device not found' USING ERRCODE = 'P0002';
  END IF;

  IF claimed_device.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'Device is already claimed' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.devices
  SET owner_id = requesting_user_id
  WHERE id = requested_device_id
  RETURNING * INTO claimed_device;

  INSERT INTO public.device_members (device_id, user_id, role)
  VALUES (requested_device_id, requesting_user_id, 'owner')
  ON CONFLICT (device_id, user_id) DO UPDATE SET role = 'owner';

  RETURN claimed_device;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_device(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_device(UUID, UUID) TO service_role;
