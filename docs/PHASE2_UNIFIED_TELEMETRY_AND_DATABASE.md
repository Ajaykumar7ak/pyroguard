# PYROGUARD-H | Phase 2 Documentation: Unified Telemetry Backend & Local Database

## 1. Executive Summary
Phase 2 implements a resilient, local-first SQLite persistence and telemetry normalization layer for PYROGUARD-H. The application operates **100% offline without internet dependency**. All hardware sensor readings from the ESP32 (via Python serial collector on COM4 or browser Web Serial) are validated, deduplicated, and persisted into SQLite before real-time WebSocket distribution to client dashboards. Active hazard incidents are tracked across state transitions without duplicate alarm spamming, and staged into a durable cloud synchronization queue for the upcoming Phase 3 cloud backup phase.

---

## 2. Local-First SQLite Database Architecture

- **Database File**: `backend/pyroguard.db`
- **Engine**: SQLite 3 (Standard Library)
- **Concurrency & Resilience**:
  - `PRAGMA journal_mode = WAL;` (Write-Ahead Logging for non-blocking concurrent reads and writes)
  - `PRAGMA synchronous = NORMAL;` (Safe, low-latency disk writes)
  - `PRAGMA foreign_keys = ON;`
  - `PRAGMA busy_timeout = 5000;` (Graceful concurrency queueing)

### Database Tables & Schema

#### 1. `sensor_readings`
| Column Name | Type | Constraints | Description |
|---|---|---|---|
| `reading_id` | TEXT | PRIMARY KEY | Unique UUID identifier for the reading |
| `device_id` | TEXT | NOT NULL | Device identifier (e.g. `PYRO-ESP32`) |
| `timestamp_utc` | TEXT | NOT NULL | Server-generated ISO-8601 UTC receipt timestamp |
| `uptime_ms` | INTEGER | NULLABLE | Microcontroller device uptime in milliseconds |
| `temperature_c` | REAL | NULLABLE | Ambient temperature in Celsius (-40.0°C to 125.0°C) |
| `humidity_pct` | REAL | NULLABLE | Relative humidity percentage (0.0% to 100.0%) |
| `flame_detected` | INTEGER | NOT NULL DEFAULT 0 | Flame state (1 = Fire Detected, 0 = Clear) |
| `buzzer_on` | INTEGER | NOT NULL DEFAULT 0 | Physical buzzer state (1 = Active, 0 = Silent) |
| `source` | TEXT | NOT NULL DEFAULT 'serial' | Ingestion source (`serial`, `web_serial`, `cloud`) |
| `validation_status` | TEXT | NOT NULL DEFAULT 'VALID' | Health status (`VALID`, `DEGRADED`, `INVALID`) |
| `created_at_utc` | TEXT | NOT NULL | Record insertion UTC timestamp |

*Indexes:*
- `idx_readings_time` on `sensor_readings(timestamp_utc DESC)`
- `idx_readings_device_time` on `sensor_readings(device_id, timestamp_utc DESC)`
- `idx_readings_dedup` on `sensor_readings(device_id, uptime_ms)`

#### 2. `alarm_events`
| Column Name | Type | Constraints | Description |
|---|---|---|---|
| `event_id` | TEXT | PRIMARY KEY | Unique UUID identifier for the hazard incident |
| `device_id` | TEXT | NOT NULL | Node ID that triggered the hazard |
| `event_type` | TEXT | NOT NULL | Incident category (`FLAME_HAZARD`, `HIGH_TEMPERATURE`) |
| `severity` | TEXT | NOT NULL | Severity rating (`CRITICAL`, `WARNING`, `INFO`) |
| `source` | TEXT | NOT NULL | Detection origin (`hardware_sensor`, `software_threshold`) |
| `start_time_utc` | TEXT | NOT NULL | ISO-8601 timestamp when incident began |
| `end_time_utc` | TEXT | NULLABLE | ISO-8601 timestamp when hazard cleared |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 | 1 = Incident active, 0 = Incident resolved |
| `is_acknowledged` | INTEGER | NOT NULL DEFAULT 0 | 1 = Operator acknowledged, 0 = Unacknowledged |
| `acknowledged_at_utc`| TEXT | NULLABLE | Timestamp of operator acknowledgment |
| `operator_notes` | TEXT | NULLABLE | Operator audit notes entered during acknowledgment |
| `created_at_utc` | TEXT | NOT NULL | Row creation timestamp |

*Indexes:*
- `idx_alarms_active` on `alarm_events(is_active, start_time_utc DESC)`
- `idx_alarms_device` on `alarm_events(device_id, start_time_utc DESC)`

#### 3. `devices`
| Column Name | Type | Constraints | Description |
|---|---|---|---|
| `device_id` | TEXT | PRIMARY KEY | Unique device name (e.g. `PYRO-ESP32`) |
| `device_type` | TEXT | NOT NULL | Hardware profile (`ESP32_SENSOR_NODE`, `ESP32_CAM`) |
| `connection_status` | TEXT | NOT NULL | State (`CONNECTED`, `WAITING FOR DATA`, `STALE`, `DISCONNECTED`, `ERROR`) |
| `last_reading_utc` | TEXT | NULLABLE | Timestamp of latest valid telemetry packet |
| `last_seen_utc` | TEXT | NOT NULL | Most recent communication timestamp |
| `diagnostics` | TEXT | NULLABLE | JSON string with baud rate, COM port, or error details |

#### 4. `sync_queue` (Durable Cloud Staging)
| Column Name | Type | Constraints | Description |
|---|---|---|---|
| `queue_id` | TEXT | PRIMARY KEY | Unique queue transaction UUID |
| `record_type` | TEXT | NOT NULL | Staged data category (`sensor_reading`, `alarm_event`) |
| `payload_reference` | TEXT | NOT NULL | Foreign reference to `reading_id` or `event_id` |
| `payload_json` | TEXT | NOT NULL | Normalized JSON payload ready for cloud sync |
| `created_at_utc` | TEXT | NOT NULL | Creation timestamp |
| `sync_status` | TEXT | NOT NULL DEFAULT 'PENDING' | Status (`PENDING`, `SYNCED`, `FAILED`) |
| `attempt_count` | INTEGER | NOT NULL DEFAULT 0 | Upload retry count |
| `last_error` | TEXT | NULLABLE | Error message from failed attempt |
| `next_retry_at_utc`| TEXT | NULLABLE | Exponential backoff retry time |

*Indexes:*
- `idx_sync_queue_status` on `sync_queue(sync_status, created_at_utc ASC)`

---

## 3. Unified Telemetry Contract

Incoming packets from firmware CSV (`uptime_ms,temp,humidity,,flame,buzzer,dht_ok` or standard 6-column CSV), NDJSON, and human-readable text are validated and normalized into the unified contract:

```json
{
  "reading_id": "90ab2c52-6362-406c-a2cb-3d7155e30a99",
  "device_id": "PYRO-ESP32",
  "timestamp_utc": "2026-10-17T15:27:37.123456Z",
  "uptime_ms": 79123,
  "temperature_c": 33.5,
  "humidity_pct": 72.0,
  "flame_detected": true,
  "buzzer_on": true,
  "source": "serial",
  "validation_status": "VALID"
}
```

### Validation & Deduplication Rules
1. **Range Validation**:
   - Temperature outside `-40.0°C` to `125.0°C` is marked invalid and rejected.
   - Humidity outside `0.0%` to `100.0%` is marked invalid and rejected.
2. **Missing Field Preservation**:
   - When DHT22 sensor encounters hardware read error (`isnan()`), temperature and humidity are recorded as `null`, while valid flame and buzzer readings are preserved with `validation_status: "DEGRADED"`.
3. **Deduplication**:
   - Identical packets containing matching `uptime_ms` submitted within a retransmission window are skipped from duplicate SQLite insertion.
4. **Device vs. Server Timestamps**:
   - `uptime_ms` represents microcontroller runtime reported by the device.
   - `timestamp_utc` represents verified server receipt time.

---

## 4. Hazard Alarm Event State Machine

1. **Incident Triggering**:
   - When `flame_detected` transitions `0 -> 1`, a single `CRITICAL` alarm is created in `alarm_events` and staged into `sync_queue`.
   - Subsequent readings with `flame_detected == 1` do **not** create duplicate alarms while the incident remains active.
2. **Incident Resolution**:
   - When `flame_detected` transitions `1 -> 0`, the active incident is resolved (`is_active = 0`, `end_time_utc = timestamp_utc`).
3. **Thermal Warnings**:
   - Configurable high-temperature threshold (`dht_high_temp_threshold`, default 50.0°C) triggers `WARNING` alarms with `source="software_threshold"`.
4. **Operator Acknowledgment**:
   - Operators can acknowledge active or historical alarms via `POST /api/alarms/{event_id}/acknowledge`, logging operator audit notes and timestamps.

---

## 5. Backend REST & WebSocket API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Service health, version, database status, and sensor port state |
| `GET` | `/api/database/status` | SQLite file size, WAL journal mode, integrity check, and record counts |
| `GET` | `/api/sensor/status` | Current serial collector connection state, bytes, and stream age |
| `GET` | `/api/sensor/ports` | Scans hardware COM ports (CP210x, CH340, FTDI) |
| `POST` | `/api/sensor/connect` | Connects exclusive reader to COM port at specified baud rate |
| `POST` | `/api/sensor/disconnect` | Releases COM port safely without deleting history |
| `GET` | `/api/sensor/readings/latest` | Returns most recent validated reading |
| `GET` | `/api/sensor/readings/history` | Paginated query (`limit`, `offset`, `start_time`, `end_time`, `device_id`) |
| `POST` | `/api/sensor/telemetry` | Ingests Web Serial or external sensor payloads into unified pipeline |
| `GET` | `/api/alarms` | Paginated alarms with `active_only` and `severity` filters |
| `POST` | `/api/alarms/{id}/acknowledge` | Records operator acknowledgment and notes |
| `GET` | `/api/devices` | Returns tracked device registry and diagnostics |
| `GET` | `/api/camera/stream` | Non-buffering MJPEG camera stream proxy |
| `GET` | `/api/camera/capture` | Fresh snapshot fallback proxy |
| `POST` | `/api/camera/test` | Independent web UI and MJPEG stream diagnostic suite |
| `WS` | `/ws/telemetry` | Real-time WebSocket feed broadcasting saved SQLite readings to all clients |

---

## 6. Startup Commands

### Start Backend Service (FastAPI + SQLite WAL)
```powershell
cd A:\pyro_guard\backend
.\venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### Start Frontend Dashboard (React + Vite)
```powershell
cd A:\pyro_guard\frontend
npm run dev -- --host 0.0.0.0 --port 3000
```

---

## 7. Verification & Test Results Report

| Test ID | Test Description | Execution Type | Status | Details |
|---|---|---|---|---|
| **TEST-01** | Valid CSV telemetry ingestion | Automated Unit Test | **PASS** | Verified 7-field (`pyro_guard.ino`) and 6-field standard CSV |
| **TEST-02** | Valid JSON telemetry ingestion | Automated Unit Test | **PASS** | Verified NDJSON payload parsing and normalized schema output |
| **TEST-03** | Invalid & incomplete payload validation | Automated Unit Test | **PASS** | Out-of-bounds temps rejected; missing DHT values preserved as DEGRADED |
| **TEST-04** | Duplicate reading handling | Automated Unit Test | **PASS** | Re-transmitted packet with identical `uptime_ms` skipped from DB |
| **TEST-05** | SQLite persistence across restart | Automated Unit Test | **PASS** | Verified records persist across database connection closures |
| **TEST-06** | History pagination and date filtering | Automated Unit Test | **PASS** | Tested `limit`, `offset`, date range boundaries, and device ID filters |
| **TEST-07** | Alarm creation without duplicate spam | Automated Unit Test | **PASS** | Flame 0->1 created 1 alarm; consecutive 1s produced 0 duplicates; 1->0 resolved alarm |
| **TEST-08** | Multi-client updates via broadcast | Automated Unit Test | **PASS** | Multiple listeners received simultaneous updates upon database insert |
| **TEST-09** | Cloud sync queue staging | Automated Unit Test | **PASS** | `sync_queue` table verified storing serialized payloads in PENDING state |
| **TEST-10** | Database status and WAL integrity | Automated Unit Test | **PASS** | Verified `PRAGMA integrity_check` == OK and `journal_mode` == WAL |
| **TEST-11** | Live REST & WebSocket Integration | Live E2E Script | **PASS** | All 10 live endpoints and `/ws/telemetry` ping/pong tested on port 8000 |
| **TEST-12** | React production bundle build | Build Tooling | **PASS** | `npm run build` compiled 0 errors, 1.11s |
| **TEST-13** | Visual UI rendering & interaction | Headless Browser Subagent | **PASS** | Verified dark glassmorphism, DB health pill, alarm table, and history table |
| **TEST-14** | Live ESP32-CAM stream proxy | Hardware Diagnostic | **PASS** | Verified live MJPEG streaming and snapshot capture on `10.131.84.41` |
| **TEST-15** | Serial COM ports detection | Hardware Diagnostic | **PASS** | Detected `COM4` (CP210x ESP32) and `COM8` (FTDI) |

### Test Scope Distinction
- **Automated Tests Passed**: 10/10 unit tests in `backend/test_phase2.py`, 10/10 endpoints in `backend/test_e2e_api.py`.
- **Simulated Tests**: Ingestion payload boundary conditions (999°C, 150% RH) were simulated in software test harnesses to test defensive rejection without requiring dangerous physical overheating.
- **Physical Hardware Tests**: ESP32-CAM stream verified live on `10.131.84.41`; COM ports verified live (`COM4`, `COM8`).
