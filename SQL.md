-- 1. Profiles Table
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT NULL, -- Optional avatar
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Devices Table
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My Purifier',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'online', 'dispensing', 'flushing')),
  tank_level_ml INTEGER DEFAULT 0,
  current_tds INTEGER DEFAULT 0,
  filter_life_liters NUMERIC DEFAULT 1000.0, 
  firmware_version TEXT NULL, -- Optional firmware version
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Dispense Sessions Table
CREATE TABLE dispense_sessions (
  id UUID PRIMARY KEY, -- Provided by the RPi (Idempotent key)
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL, 
  volume_ml INTEGER NOT NULL CHECK (volume_ml > 0),
  avg_tds_out INTEGER NULL,      -- Optional (in case TDS sensor fails/isn't ready)
  temperature_c NUMERIC NULL,    -- Optional (if temp probe isn't attached)
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Command Logs Table
CREATE TABLE command_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE NOT NULL,
  issued_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  command TEXT NOT NULL CHECK (command IN ('flush', 'drain', 'reboot', 'update_firmware')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ==========================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispense_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_logs ENABLE ROW LEVEL SECURITY;

-- PROFILES
CREATE POLICY "Profiles are viewable by everyone" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- DEVICES
CREATE POLICY "Users can view their own devices" ON devices FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "Users can update their own devices" ON devices FOR UPDATE USING (auth.uid() = owner_id);

-- DISPENSE SESSIONS
CREATE POLICY "Users can view sessions for their devices" ON dispense_sessions 
FOR SELECT USING (
  EXISTS (SELECT 1 FROM devices WHERE devices.id = dispense_sessions.device_id AND devices.owner_id = auth.uid())
);
CREATE POLICY "Owners can reassign guest sessions" ON dispense_sessions 
FOR UPDATE USING (
  EXISTS (SELECT 1 FROM devices WHERE devices.id = dispense_sessions.device_id AND devices.owner_id = auth.uid())
);

-- COMMAND LOGS
CREATE POLICY "Users can view commands for their devices" ON command_logs 
FOR SELECT USING (
  EXISTS (SELECT 1 FROM devices WHERE devices.id = command_logs.device_id AND devices.owner_id = auth.uid())
);
CREATE POLICY "Users can insert commands for their devices" ON command_logs 
FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM devices WHERE devices.id = command_logs.device_id AND devices.owner_id = auth.uid())
);

-- ==========================================
-- FOLLOW-UP MIGRATION
-- ==========================================
-- The production membership model, helper functions, indexes, dashboard view,
-- signup trigger, and claim_device transaction live in:
-- supabase/migrations/002_device_members.sql
-- Apply that migration after this base schema; it replaces the owner_id-only
-- policies above with device_members-based access control.
