# PYROGUARD-H | Supabase Cloud Database Setup & Migration Guide

This guide provides the complete PostgreSQL schema, Row Level Security (RLS) policies, and step-by-step instructions for integrating your PYROGUARD-H host with a Supabase cloud instance.

---

## 1. Step-by-Step Operator Setup

### Step 1: Create a Supabase Project
1. Navigate to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New Project** and choose an organization.
3. Set a project name (e.g. `pyroguard-cloud`).
4. Set a strong database password and select a region close to your deployment.
5. Wait ~2 minutes for the database provisioning to complete.

### Step 2: Run the Database Migration SQL
1. In your Supabase dashboard, go to the **SQL Editor** tab (left navigation).
2. Click **New query**.
3. Copy and paste the complete SQL script from **Section 2** below.
4. Click **Run** (or press Ctrl+Enter).
5. Verify that all tables (`sensor_readings`, `alarm_events`, `devices`) and indexes are created successfully.

### Step 3: Retrieve Project API Credentials
1. Go to **Project Settings** (gear icon at the bottom left) -> **API**.
2. Copy the **Project URL** (e.g. `https://xxxxxxxxxxxxxxxxxxxx.supabase.co`).
3. Under **Project API Keys**, locate the **`service_role`** key (marked *secret*).
   > [!WARNING]
   > Use the `service_role` secret key for backend synchronization. Do **NOT** use the public `anon` key.
   > Keep this key confidential and **never** commit it to version control or expose it to frontend client code.

### Step 4: Configure Local Backend `.env`
1. On the local host machine, open `a:\pyro_guard\backend`.
2. Copy `.env.example` to `.env`:
   ```powershell
   copy .env.example .env
   ```
3. Edit `backend/.env` with your actual project credentials:
   ```ini
   CLOUD_SYNC_ENABLED=true
   CLOUD_PROVIDER=supabase
   SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...your_actual_service_role_key
   CLOUD_SYNC_INTERVAL_SECONDS=30
   CLOUD_SYNC_BATCH_SIZE=50
   ```
4. Restart the FastAPI backend or trigger a manual sync in the dashboard.

---

## 2. PostgreSQL Schema & Migration Script

Execute this complete DDL in the Supabase SQL Editor:

```sql
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
-- Enable RLS on all tables
ALTER TABLE public.sensor_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alarm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

-- Allow service_role full read and write access (used by the backend sync worker)
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

-- Optional: Allow authenticated dashboard operators read-only access
CREATE POLICY "Allow authenticated read on sensor_readings"
    ON public.sensor_readings
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated read on alarm_events"
    ON public.alarm_events
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated read on devices"
    ON public.devices
    FOR SELECT
    TO authenticated
    USING (true);
```

---

## 3. Cloud Synchronization Verification

Once `.env` is configured and the backend is running:
1. Open the dashboard at `http://localhost:3000/`.
2. Navigate to the **Cloud Backup & Sync** panel.
3. Click **Sync Now**.
4. In your Supabase dashboard, open the **Table Editor** -> `sensor_readings`.
5. Verify that your queued sensor readings and alarm events appear with matching `reading_id` and `timestamp_utc`.
