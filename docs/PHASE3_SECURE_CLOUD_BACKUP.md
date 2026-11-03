# PYROGUARD-H | Phase 3: Secure Cloud Backup and Offline Synchronization

## 1. Executive Summary

Phase 3 introduces an optional, robust cloud synchronization layer for the PYROGUARD-H Industrial Worker Safety & Hazard Telemetry Platform. Targeting **Supabase (PostgreSQL)** via PostgREST, Phase 3 preserves local SQLite as the definitive source of truth while ensuring seamless background replication whenever network connectivity is present.

### Key Architectural Tenets
1. **Local-First Autonomy**: Sensor acquisition on USB serial (COM4) and the physical hardware buzzer loop operate with zero dependencies on cloud reachability or internet connectivity.
2. **Durable Sync Queue**: Every valid sensor reading and alarm event is transactionally staged into SQLite's `sync_queue` table during local ingestion.
3. **Idempotent Batch Upserts**: Records are pushed to Supabase PostgREST with the `resolution=merge-duplicates` directive. Duplicate payloads or re-queued batches merge safely without primary key collision errors or duplicate row inflation.
4. **Resilient Retry & Backoff**: The background synchronization worker executes every 30 seconds. On network failure or HTTP errors, retry counters increment with exponential backoff (up to 5 attempts), leaving records in the SQLite queue until confirmation is received.
5. **Zero-Leak Host Credential Model**: Privileged credentials (`SUPABASE_SERVICE_ROLE_KEY`) reside exclusively in host-side `backend/.env`. Public APIs mask key secrets, and `.gitignore` prevents credential exposure.

---

## 2. System Architecture

```
+-------------------------------------------------------------------------+
|                              LOCAL HOST                                 |
|                                                                         |
|  [ESP32 SENSOR NODE] (DHT22 + Flame)                                    |
|          | USB Serial (COM4 @ 115200 baud)                              |
|          v                                                              |
|  [Python Serial Collector / FastAPI Backend]                           |
|          |                                                              |
|          +---> [Local SQLite Engine (WAL Mode)]                         |
|          |        ├── sensor_readings (Source of Truth)                 |
|          |        ├── alarm_events                                      |
|          |        └── sync_queue (Staged Payloads)                      |
|          |                                                              |
|          +---> [30s Background Sync Worker]                             |
|                   ├── Internet Probe (DNS / CloudFlare HTTPS)           |
|                   ├── Batch Fetch (Pending Records, limit=50)           |
|                   ├── POST /rest/v1/<table> (Prefer: merge-duplicates)  |
|                   └── Mark Confirmed / Increment Retry                  |
+----------------------------------|--------------------------------------+
                                   | HTTPS (TLS 1.3)
                                   v
+-------------------------------------------------------------------------+
|                        SUPABASE CLOUD PLATFORM                          |
|                                                                         |
|  [PostgREST API Gateway]                                                |
|          |                                                              |
|  [Managed PostgreSQL Database]                                          |
|          ├── sensor_readings (Indexed by device_id, timestamp_utc)      |
|          ├── alarm_events (Critical hazard audit history)               |
|          └── devices (Heartbeats & provisioned nodes)                   |
|                                                                         |
|  [Row-Level Security (RLS) & Operator Policies]                         |
+-------------------------------------------------------------------------+
```

---

## 3. Database Schema & Synchronization Model

### Local SQLite Schema (`a:/pyro_guard/backend/data/pyroguard.db`)

#### `sync_queue` Table
```sql
CREATE TABLE IF NOT EXISTS sync_queue (
    queue_id TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,         -- 'sensor_reading' | 'alarm_event'
    record_id TEXT NOT NULL,           -- Foreign key reference to source row
    payload JSON NOT NULL,             -- Pre-serialized JSON payload for cloud
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING' | 'SYNCED' | 'FAILED'
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_utc TEXT,
    last_error TEXT,
    created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status_attempts 
ON sync_queue (status, attempts);
```

### Remote Supabase PostgreSQL Schema
Detailed DDL migrations and RLS policies are documented in [`docs/SUPABASE_SETUP_GUIDE.md`](file:///a:/pyro_guard/docs/SUPABASE_SETUP_GUIDE.md).

Tables:
- `public.devices`: Registry of nodes, firmware version, and last heartbeat.
- `public.sensor_readings`: Cloned schema of local SQLite readings, with `reading_id UUID PRIMARY KEY`.
- `public.alarm_events`: Cloned schema of critical hazard events, with `event_id UUID PRIMARY KEY`.

---

## 4. API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/cloud/status` | Current cloud service status, host connectivity, and queue counts |
| `POST` | `/api/cloud/sync-now` | Triggers immediate non-blocking batch sync cycle |
| `GET` | `/api/cloud/sync-history` | Returns recent staged queue records with attempt logs |
| `POST` | `/api/cloud/retry-failed` | Resets failed items (attempts >= 5) back to `PENDING` |
| `GET` | `/api/health` | Comprehensive health check including local DB and cloud status |

### Example Response: `GET /api/cloud/status`
```json
{
  "cloud_configured": false,
  "internet_available": true,
  "status": "NOT_CONFIGURED",
  "provider": "supabase",
  "queue": {
    "pending": 6,
    "synced": 0,
    "failed": 0,
    "total": 6
  },
  "config": {
    "enabled": false,
    "url": null,
    "has_key": false,
    "batch_size": 50,
    "sync_interval_seconds": 30
  },
  "worker": {
    "is_running": true,
    "is_syncing": false,
    "last_sync_utc": null,
    "last_error": null,
    "consecutive_failures": 0
  }
}
```

---

## 5. Security & Operator Configuration

### Environment Variables (`backend/.env`)
Copy template from `backend/.env.example`:
```bash
# Cloud Provider Configuration
CLOUD_SYNC_ENABLED=true
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...your_service_role_key...
CLOUD_BATCH_SIZE=50
CLOUD_SYNC_INTERVAL_SECONDS=30
```

> **Security Note**: Never commit `backend/.env` to source control. The repository `.gitignore` automatically excludes `.env`, `*.db`, and `__pycache__`.

---

## 6. Test Suite & Validation

The Phase 3 test suite ([`backend/test_phase3.py`](file:///a:/pyro_guard/backend/test_phase3.py)) validates 10 automated test scenarios:

1. `test_cloud_config_unconfigured`: Verifies safe fallback when `.env` is unconfigured.
2. `test_cloud_config_safe_masking`: Verifies privileged keys are never leaked via config inspect APIs.
3. `test_sync_queue_enqueuing`: Verifies local readings and alarms are queued in SQLite.
4. `test_sync_queue_fetch_and_mark_success`: Verifies pending record retrieval and success updates.
5. `test_sync_queue_retry_and_backoff`: Verifies failure counter increments and marking failed at max retries.
6. `test_supabase_provider_unconfigured`: Verifies graceful failure when credentials are missing.
7. `test_supabase_provider_offline_handling`: Verifies offline host aborts without crashing worker.
8. `test_supabase_mock_successful_sync`: Verifies idempotent batch upserts with `Prefer: resolution=merge-duplicates`.
9. `test_sync_worker_cycle`: Verifies non-blocking single-cycle execution of the background worker.
10. `test_cloud_api_endpoints`: Verifies FastAPI routes `/api/cloud/status`, `/sync-now`, and `/retry-failed`.

### Regression Verification
Phase 2 test suite ([`backend/test_phase2.py`](file:///a:/pyro_guard/backend/test_phase2.py)) also ran cleanly with **10/10 passed**, confirming complete backward compatibility.
