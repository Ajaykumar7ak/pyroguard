-- ============================================================================
-- PYROGUARD-H Cloud Schema Migration (PostgreSQL / Supabase)
-- ============================================================================

-- 1. Table: sensor_readings
CREATE TABLE IF NOT EXISTS public.sensor_readings (
    reading_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL DEFAULT 'PYRO-ESP32',
    timestamp_utc TIMESTAMPTZ NOT NULL,
    uptime_ms BIGINT,
    temperature_c NUMERIC(5, 2),
    humidity_pct NUMERIC(5, 2),
    flame_detected BOOLEAN NOT NULL DEFAULT FALSE,
    buzzer_on BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'serial',
    validation_status TEXT NOT NULL DEFAULT 'VALID',
    synced_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast analytics and time-series queries
CREATE INDEX IF NOT EXISTS idx_cloud_readings_time 
    ON public.sensor_readings (timestamp_utc DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_readings_device_time 
    ON public.sensor_readings (device_id, timestamp_utc DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_readings_flame 
    ON public.sensor_readings (flame_detected, timestamp_utc DESC);

-- 2. Table: alarm_events
CREATE TABLE IF NOT EXISTS public.alarm_events (
    event_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL DEFAULT 'PYRO-ESP32',
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'hardware_sensor',
    start_time_utc TIMESTAMPTZ NOT NULL,
    end_time_utc TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged_at_utc TIMESTAMPTZ,
    operator_notes TEXT,
    synced_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for active incidents and audit queries
CREATE INDEX IF NOT EXISTS idx_cloud_alarms_active 
    ON public.alarm_events (is_active, start_time_utc DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_alarms_device 
    ON public.alarm_events (device_id, start_time_utc DESC);

-- 3. Table: devices
CREATE TABLE IF NOT EXISTS public.devices (
    device_id TEXT PRIMARY KEY,
    device_type TEXT NOT NULL DEFAULT 'ESP32_SENSOR_NODE',
    connection_status TEXT NOT NULL,
    last_reading_utc TIMESTAMPTZ,
    last_seen_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    diagnostics TEXT,
    synced_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Row Level Security (RLS) Configuration
-- ============================================================================
ALTER TABLE public.sensor_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alarm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

-- 1. Service Role (Full bypass/access for secret backend key)
CREATE POLICY "Allow service_role full access to sensor_readings"
    ON public.sensor_readings
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow service_role full access to alarm_events"
    ON public.alarm_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow service_role full access to devices"
    ON public.devices
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 2. Anon / Publishable Key (Allow INSERT and SELECT for publishable key syncing)
CREATE POLICY "Allow anon insert to sensor_readings"
    ON public.sensor_readings
    FOR INSERT
    TO anon
    WITH CHECK (true);

CREATE POLICY "Allow anon update to sensor_readings"
    ON public.sensor_readings
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow anon select to sensor_readings"
    ON public.sensor_readings
    FOR SELECT
    TO anon
    USING (true);

CREATE POLICY "Allow anon insert to alarm_events"
    ON public.alarm_events
    FOR INSERT
    TO anon
    WITH CHECK (true);

CREATE POLICY "Allow anon update to alarm_events"
    ON public.alarm_events
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow anon select to alarm_events"
    ON public.alarm_events
    FOR SELECT
    TO anon
    USING (true);

CREATE POLICY "Allow anon insert to devices"
    ON public.devices
    FOR INSERT
    TO anon
    WITH CHECK (true);

CREATE POLICY "Allow anon update to devices"
    ON public.devices
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow anon select to devices"
    ON public.devices
    FOR SELECT
    TO anon
    USING (true);

-- 3. Authenticated Users (Read & Write)
CREATE POLICY "Allow authenticated read/write to sensor_readings"
    ON public.sensor_readings
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow authenticated read/write to alarm_events"
    ON public.alarm_events
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow authenticated read/write to devices"
    ON public.devices
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);
