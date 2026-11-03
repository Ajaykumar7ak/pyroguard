import sqlite3
import os
import json
import uuid
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

logger = logging.getLogger("pyroguard.db")

# Default database path in the backend directory
DB_FILE_PATH = Path(__file__).resolve().parent / "pyroguard.db"

def get_db_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """
    Creates and configures a thread-safe SQLite connection with WAL journal mode,
    foreign keys, and appropriate timeout for high concurrency.
    """
    target_path = str(db_path or DB_FILE_PATH)
    conn = sqlite3.connect(target_path, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    
    # Enable WAL mode for non-blocking concurrent reads and writes
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn

def init_db(db_path: Optional[Path] = None):
    """
    Initializes or extends the SQLite database schema with all required Phase 2 tables:
    sensor_readings, alarm_events, devices, and sync_queue.
    Uses CREATE TABLE IF NOT EXISTS and safe column migrations so existing data is never destroyed.
    """
    conn = get_db_connection(db_path)
    try:
        with conn:
            # 1. sensor_readings table
            conn.execute("""
            CREATE TABLE IF NOT EXISTS sensor_readings (
                reading_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                timestamp_utc TEXT NOT NULL,
                uptime_ms INTEGER,
                temperature_c REAL,
                humidity_pct REAL,
                flame_detected INTEGER NOT NULL DEFAULT 0,
                buzzer_on INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'serial',
                validation_status TEXT NOT NULL DEFAULT 'VALID',
                created_at_utc TEXT NOT NULL
            );
            """)

            # 2. alarm_events table
            conn.execute("""
            CREATE TABLE IF NOT EXISTS alarm_events (
                event_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'hardware_sensor',
                start_time_utc TEXT NOT NULL,
                end_time_utc TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                is_acknowledged INTEGER NOT NULL DEFAULT 0,
                acknowledged_at_utc TEXT,
                operator_notes TEXT,
                created_at_utc TEXT NOT NULL
            );
            """)

            # 3. devices table
            conn.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                device_type TEXT NOT NULL,
                connection_status TEXT NOT NULL,
                last_reading_utc TEXT,
                last_seen_utc TEXT NOT NULL,
                diagnostics TEXT
            );
            """)

            # 4. sync_queue table (Durable cloud backup staging queue for Phase 3)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS sync_queue (
                queue_id TEXT PRIMARY KEY,
                record_type TEXT NOT NULL,
                payload_reference TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at_utc TEXT NOT NULL,
                sync_status TEXT NOT NULL DEFAULT 'PENDING',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                next_retry_at_utc TEXT
            );
            """)

            # 5. ppe_incidents table (Phase 5A: 60-Second PPE violation evidence & incident tracking)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS ppe_incidents (
                incident_id TEXT PRIMARY KEY,
                track_id INTEGER NOT NULL,
                missing_ppe TEXT NOT NULL,
                violation_start_utc TEXT NOT NULL,
                trigger_time_utc TEXT NOT NULL,
                resolved_time_utc TEXT,
                duration_seconds REAL NOT NULL DEFAULT 60.0,
                status TEXT NOT NULL DEFAULT 'OPEN',
                evidence_image_path TEXT,
                operator_notes TEXT,
                created_at_utc TEXT NOT NULL
            );
            """)

            # Safe indexes for high performance querying
            conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_time ON sensor_readings(timestamp_utc DESC);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_device_time ON sensor_readings(device_id, timestamp_utc DESC);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_dedup ON sensor_readings(device_id, uptime_ms);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_alarms_active ON alarm_events(is_active, start_time_utc DESC);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_alarms_device ON alarm_events(device_id, start_time_utc DESC);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(sync_status, created_at_utc ASC);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_ppe_incidents_status ON ppe_incidents(status);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_ppe_incidents_time ON ppe_incidents(trigger_time_utc DESC);")

            # Default device entry for PYRO-ESP32
            conn.execute("""
            INSERT OR IGNORE INTO devices (device_id, device_type, connection_status, last_seen_utc, diagnostics)
            VALUES (?, ?, ?, ?, ?)
            """, (
                "PYRO-ESP32",
                "ESP32_SENSOR_NODE",
                "DISCONNECTED",
                datetime.now(timezone.utc).isoformat(),
                json.dumps({"firmware": "pyro_guard.ino", "com_port": "COM4", "baud": 115200})
            ))

        logger.info(f"Database schema initialized successfully at {db_path or DB_FILE_PATH}")
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# Sensor Readings CRUD
# ---------------------------------------------------------------------------

def insert_sensor_reading(
    reading: Dict[str, Any], 
    db_path: Optional[Path] = None
) -> Tuple[bool, str]:
    """
    Inserts a validated normalized sensor reading into SQLite.
    Returns (success: bool, reading_id: str).
    """
    conn = get_db_connection(db_path)
    reading_id = reading.get("reading_id") or str(uuid.uuid4())
    device_id = reading.get("device_id", "PYRO-ESP32")
    timestamp_utc = reading.get("timestamp_utc") or datetime.now(timezone.utc).isoformat()
    now_utc = datetime.now(timezone.utc).isoformat()

    try:
        with conn:
            conn.execute("""
            INSERT INTO sensor_readings (
                reading_id, device_id, timestamp_utc, uptime_ms, 
                temperature_c, humidity_pct, flame_detected, buzzer_on, 
                source, validation_status, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                reading_id,
                device_id,
                timestamp_utc,
                reading.get("uptime_ms"),
                reading.get("temperature_c"),
                reading.get("humidity_pct"),
                1 if reading.get("flame_detected") else 0,
                1 if reading.get("buzzer_on") else 0,
                reading.get("source", "serial"),
                reading.get("validation_status", "VALID"),
                now_utc
            ))

            # Also stage into sync_queue for cloud backup in Phase 3
            queue_id = str(uuid.uuid4())
            conn.execute("""
            INSERT INTO sync_queue (
                queue_id, record_type, payload_reference, payload_json, 
                created_at_utc, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """, (
                queue_id,
                "sensor_reading",
                reading_id,
                json.dumps({**reading, "reading_id": reading_id, "timestamp_utc": timestamp_utc}),
                now_utc,
                "PENDING"
            ))

        return True, reading_id
    except sqlite3.IntegrityError as e:
        logger.warning(f"Duplicate reading ignored: {e}")
        return False, reading_id
    except Exception as e:
        logger.error(f"Error inserting sensor reading: {e}")
        return False, str(e)
    finally:
        conn.close()

def get_latest_sensor_reading(
    device_id: Optional[str] = None, 
    db_path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Returns the most recent sensor reading from the database."""
    conn = get_db_connection(db_path)
    try:
        query = "SELECT * FROM sensor_readings"
        params: List[Any] = []
        if device_id:
            query += " WHERE device_id = ?"
            params.append(device_id)
        query += " ORDER BY timestamp_utc DESC LIMIT 1;"

        cur = conn.execute(query, params)
        row = cur.fetchone()
        if row:
            d = dict(row)
            d["flame_detected"] = bool(d["flame_detected"])
            d["buzzer_on"] = bool(d["buzzer_on"])
            return d
        return None
    finally:
        conn.close()

def get_sensor_readings_history(
    limit: int = 50,
    offset: int = 0,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    device_id: Optional[str] = None,
    db_path: Optional[Path] = None
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Returns paginated sensor readings with optional date range and device filters,
    along with total matching count.
    """
    limit = min(max(1, limit), 500)
    offset = max(0, offset)

    conn = get_db_connection(db_path)
    try:
        where_clauses = []
        params: List[Any] = []

        if device_id:
            where_clauses.append("device_id = ?")
            params.append(device_id)
        if start_time:
            where_clauses.append("timestamp_utc >= ?")
            params.append(start_time)
        if end_time:
            where_clauses.append("timestamp_utc <= ?")
            params.append(end_time)

        where_sql = f" WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Total count
        count_cur = conn.execute(f"SELECT COUNT(*) FROM sensor_readings{where_sql};", params)
        total_count = count_cur.fetchone()[0]

        # Paginated rows
        query = f"SELECT * FROM sensor_readings{where_sql} ORDER BY timestamp_utc DESC LIMIT ? OFFSET ?;"
        readings_cur = conn.execute(query, params + [limit, offset])
        rows = readings_cur.fetchall()

        results = []
        for r in rows:
            d = dict(r)
            d["flame_detected"] = bool(d["flame_detected"])
            d["buzzer_on"] = bool(d["buzzer_on"])
            results.append(d)

        return results, total_count
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# Alarm Events CRUD
# ---------------------------------------------------------------------------

def create_alarm_event(
    event: Dict[str, Any], 
    db_path: Optional[Path] = None
) -> Tuple[bool, str]:
    """
    Inserts a new active alarm event and stages it into sync_queue.
    """
    conn = get_db_connection(db_path)
    event_id = event.get("event_id") or str(uuid.uuid4())
    device_id = event.get("device_id", "PYRO-ESP32")
    event_type = event.get("event_type", "FLAME_HAZARD")
    severity = event.get("severity", "CRITICAL")
    source = event.get("source", "hardware_sensor")
    start_time_utc = event.get("start_time_utc") or datetime.now(timezone.utc).isoformat()
    now_utc = datetime.now(timezone.utc).isoformat()

    try:
        with conn:
            conn.execute("""
            INSERT INTO alarm_events (
                event_id, device_id, event_type, severity, source,
                start_time_utc, is_active, is_acknowledged, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
            """, (
                event_id, device_id, event_type, severity, source,
                start_time_utc, now_utc
            ))

            # Stage to sync queue
            queue_id = str(uuid.uuid4())
            conn.execute("""
            INSERT INTO sync_queue (
                queue_id, record_type, payload_reference, payload_json, 
                created_at_utc, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """, (
                queue_id,
                "alarm_event",
                event_id,
                json.dumps({
                    "event_id": event_id,
                    "device_id": device_id,
                    "event_type": event_type,
                    "severity": severity,
                    "source": source,
                    "start_time_utc": start_time_utc,
                    "action": "CREATE"
                }),
                now_utc,
                "PENDING"
            ))

        return True, event_id
    except Exception as e:
        logger.error(f"Error creating alarm event: {e}")
        return False, str(e)
    finally:
        conn.close()

def resolve_alarm_event(
    event_id: str, 
    end_time_utc: Optional[str] = None, 
    db_path: Optional[Path] = None
) -> bool:
    """
    Marks an active alarm event as resolved (is_active = 0, end_time_utc = timestamp).
    """
    conn = get_db_connection(db_path)
    end_ts = end_time_utc or datetime.now(timezone.utc).isoformat()
    now_utc = datetime.now(timezone.utc).isoformat()

    try:
        with conn:
            conn.execute("""
            UPDATE alarm_events 
            SET is_active = 0, end_time_utc = ? 
            WHERE event_id = ? AND is_active = 1;
            """, (end_ts, event_id))

            # Enqueue resolution to sync_queue
            queue_id = str(uuid.uuid4())
            conn.execute("""
            INSERT INTO sync_queue (
                queue_id, record_type, payload_reference, payload_json, 
                created_at_utc, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """, (
                queue_id,
                "alarm_event",
                event_id,
                json.dumps({"event_id": event_id, "action": "RESOLVE", "end_time_utc": end_ts}),
                now_utc,
                "PENDING"
            ))
        return True
    except Exception as e:
        logger.error(f"Error resolving alarm event: {e}")
        return False
    finally:
        conn.close()

def get_active_alarm_by_type(
    device_id: str, 
    event_type: str, 
    db_path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Returns an active alarm for a given device and event type if one exists."""
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute("""
        SELECT * FROM alarm_events 
        WHERE device_id = ? AND event_type = ? AND is_active = 1
        ORDER BY start_time_utc DESC LIMIT 1;
        """, (device_id, event_type))
        row = cur.fetchone()
        if row:
            d = dict(row)
            d["is_active"] = bool(d["is_active"])
            d["is_acknowledged"] = bool(d["is_acknowledged"])
            return d
        return None
    finally:
        conn.close()

def get_alarm_event_by_id(
    event_id: str, 
    db_path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Retrieves a single alarm event row by its event_id."""
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute("""
        SELECT * FROM alarm_events WHERE event_id = ? LIMIT 1;
        """, (event_id,))
        row = cur.fetchone()
        if row:
            d = dict(row)
            d["is_active"] = bool(d["is_active"])
            d["is_acknowledged"] = bool(d["is_acknowledged"])
            return d
        return None
    finally:
        conn.close()

def acknowledge_alarm_event(
    event_id: str, 
    operator_notes: Optional[str] = None, 
    db_path: Optional[Path] = None
) -> bool:
    """Acknowledge an alarm event with optional operator notes."""
    conn = get_db_connection(db_path)
    now_utc = datetime.now(timezone.utc).isoformat()
    try:
        with conn:
            conn.execute("""
            UPDATE alarm_events 
            SET is_acknowledged = 1, acknowledged_at_utc = ?, operator_notes = coalesce(?, operator_notes)
            WHERE event_id = ?;
            """, (now_utc, operator_notes, event_id))

            # Enqueue acknowledge to sync_queue
            queue_id = str(uuid.uuid4())
            conn.execute("""
            INSERT INTO sync_queue (
                queue_id, record_type, payload_reference, payload_json, 
                created_at_utc, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """, (
                queue_id,
                "alarm_event",
                event_id,
                json.dumps({"event_id": event_id, "action": "ACKNOWLEDGE", "notes": operator_notes}),
                now_utc,
                "PENDING"
            ))
        return True
    except Exception as e:
        logger.error(f"Error acknowledging alarm: {e}")
        return False
    finally:
        conn.close()

def get_alarm_events(
    active_only: bool = False,
    severity: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    db_path: Optional[Path] = None
) -> Tuple[List[Dict[str, Any]], int]:
    """Retrieves paginated alarm events with optional filtering."""
    limit = min(max(1, limit), 200)
    offset = max(0, offset)

    conn = get_db_connection(db_path)
    try:
        where_clauses = []
        params: List[Any] = []

        if active_only:
            where_clauses.append("is_active = 1")
        if severity:
            where_clauses.append("severity = ?")
            params.append(severity)

        where_sql = f" WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        count_cur = conn.execute(f"SELECT COUNT(*) FROM alarm_events{where_sql};", params)
        total_count = count_cur.fetchone()[0]

        query = f"SELECT * FROM alarm_events{where_sql} ORDER BY start_time_utc DESC LIMIT ? OFFSET ?;"
        cur = conn.execute(query, params + [limit, offset])
        rows = cur.fetchall()

        events = []
        for r in rows:
            d = dict(r)
            d["is_active"] = bool(d["is_active"])
            d["is_acknowledged"] = bool(d["is_acknowledged"])
            events.append(d)

        return events, total_count
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# Devices CRUD
# ---------------------------------------------------------------------------

def upsert_device(
    device_id: str,
    device_type: str,
    connection_status: str,
    last_reading_utc: Optional[str] = None,
    diagnostics: Optional[Dict[str, Any]] = None,
    db_path: Optional[Path] = None
):
    """Inserts or updates device connection and diagnostic status."""
    conn = get_db_connection(db_path)
    now_utc = datetime.now(timezone.utc).isoformat()
    diag_str = json.dumps(diagnostics) if diagnostics is not None else None

    try:
        with conn:
            conn.execute("""
            INSERT INTO devices (
                device_id, device_type, connection_status, last_reading_utc, last_seen_utc, diagnostics
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                device_type = excluded.device_type,
                connection_status = excluded.connection_status,
                last_reading_utc = coalesce(excluded.last_reading_utc, devices.last_reading_utc),
                last_seen_utc = excluded.last_seen_utc,
                diagnostics = coalesce(excluded.diagnostics, devices.diagnostics);
            """, (device_id, device_type, connection_status, last_reading_utc, now_utc, diag_str))
    except Exception as e:
        logger.error(f"Error upserting device {device_id}: {e}")
    finally:
        conn.close()

def get_all_devices(db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Returns all tracked devices."""
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute("SELECT * FROM devices ORDER BY last_seen_utc DESC;")
        rows = cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("diagnostics"):
                try:
                    d["diagnostics"] = json.loads(d["diagnostics"])
                except Exception:
                    pass
            result.append(d)
        return result
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# Database Status & Integrity
# ---------------------------------------------------------------------------

def get_database_status(db_path: Optional[Path] = None) -> Dict[str, Any]:
    """Returns metadata, file size, table counts, and integrity status."""
    target_path = Path(db_path or DB_FILE_PATH)
    file_exists = target_path.exists()
    size_bytes = target_path.stat().st_size if file_exists else 0

    readings_count = 0
    alarms_count = 0
    active_alarms_count = 0
    devices_count = 0
    sync_pending_count = 0
    integrity = "UNKNOWN"
    journal_mode = "UNKNOWN"

    if file_exists:
        try:
            conn = get_db_connection(target_path)
            try:
                readings_count = conn.execute("SELECT COUNT(*) FROM sensor_readings;").fetchone()[0]
                alarms_count = conn.execute("SELECT COUNT(*) FROM alarm_events;").fetchone()[0]
                active_alarms_count = conn.execute("SELECT COUNT(*) FROM alarm_events WHERE is_active = 1;").fetchone()[0]
                devices_count = conn.execute("SELECT COUNT(*) FROM devices;").fetchone()[0]
                sync_pending_count = conn.execute("SELECT COUNT(*) FROM sync_queue WHERE sync_status = 'PENDING';").fetchone()[0]
                try:
                    ppe_count = conn.execute("SELECT COUNT(*) FROM ppe_incidents;").fetchone()[0]
                    ppe_open_count = conn.execute("SELECT COUNT(*) FROM ppe_incidents WHERE status = 'OPEN';").fetchone()[0]
                except Exception:
                    ppe_count = 0
                    ppe_open_count = 0
                
                # Check journal mode & integrity
                j_row = conn.execute("PRAGMA journal_mode;").fetchone()
                if j_row:
                    journal_mode = j_row[0].upper()
                
                check_row = conn.execute("PRAGMA integrity_check;").fetchone()
                if check_row and check_row[0] == "ok":
                    integrity = "OK"
                else:
                    integrity = str(check_row[0]) if check_row else "FAIL"
            finally:
                conn.close()
        except Exception as e:
            integrity = f"ERROR: {e}"

    return {
        "status": "ONLINE" if integrity == "OK" else ("UNINITIALIZED" if not file_exists else "DEGRADED"),
        "database_file": str(target_path),
        "file_size_bytes": size_bytes,
        "file_size_kb": round(size_bytes / 1024, 2),
        "journal_mode": journal_mode,
        "integrity": integrity,
        "counts": {
            "sensor_readings": readings_count,
            "alarm_events_total": alarms_count,
            "alarm_events_active": active_alarms_count,
            "devices": devices_count,
            "sync_queue_pending": sync_pending_count,
            "ppe_incidents_total": ppe_count,
            "ppe_incidents_open": ppe_open_count
        },
        "local_first_offline_ready": True
    }

# ---------------------------------------------------------------------------
# Phase 3: Cloud Synchronization Queue Operations
# ---------------------------------------------------------------------------

def get_pending_sync_records(
    limit: int = 50, 
    db_path: Optional[Path] = None
) -> List[Dict[str, Any]]:
    """
    Selects eligible pending records from sync_queue ready for cloud upload.
    Includes records that are PENDING or FAILED with next_retry_at_utc <= current time.
    """
    conn = get_db_connection(db_path)
    now_utc = datetime.now(timezone.utc).isoformat()
    try:
        cur = conn.execute("""
        SELECT * FROM sync_queue
        WHERE sync_status = 'PENDING'
           OR (sync_status = 'FAILED' AND (next_retry_at_utc IS NULL OR next_retry_at_utc <= ?))
        ORDER BY created_at_utc ASC
        LIMIT ?;
        """, (now_utc, limit))
        rows = cur.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            if d.get("payload_json"):
                try:
                    d["payload"] = json.loads(d["payload_json"])
                except Exception:
                    d["payload"] = {}
            results.append(d)
        return results
    finally:
        conn.close()

def mark_sync_records_success(
    queue_ids: List[str], 
    db_path: Optional[Path] = None
):
    """
    Marks records as successfully synced after verified confirmation from cloud provider.
    Clears previous error messages.
    """
    if not queue_ids:
        return
    conn = get_db_connection(db_path)
    try:
        with conn:
            placeholders = ",".join("?" for _ in queue_ids)
            conn.execute(f"""
            UPDATE sync_queue
            SET sync_status = 'SYNCED', last_error = NULL, next_retry_at_utc = NULL
            WHERE queue_id IN ({placeholders});
            """, queue_ids)
    finally:
        conn.close()

def mark_sync_record_failed(
    queue_id: str,
    error_message: str,
    next_retry_at_utc: Optional[str] = None,
    db_path: Optional[Path] = None
):
    """
    Records an upload failure on a specific sync queue record.
    Increments attempt_count and schedules next retry timestamp.
    """
    conn = get_db_connection(db_path)
    try:
        with conn:
            conn.execute("""
            UPDATE sync_queue
            SET sync_status = 'FAILED',
                attempt_count = attempt_count + 1,
                last_error = ?,
                next_retry_at_utc = ?
            WHERE queue_id = ?;
            """, (error_message, next_retry_at_utc, queue_id))
    finally:
        conn.close()

def get_sync_queue_summary(db_path: Optional[Path] = None) -> Dict[str, Any]:
    """Returns total counts by status and oldest pending timestamp."""
    conn = get_db_connection(db_path)
    try:
        pending_count = conn.execute("SELECT COUNT(*) FROM sync_queue WHERE sync_status = 'PENDING';").fetchone()[0]
        failed_count = conn.execute("SELECT COUNT(*) FROM sync_queue WHERE sync_status = 'FAILED';").fetchone()[0]
        synced_count = conn.execute("SELECT COUNT(*) FROM sync_queue WHERE sync_status = 'SYNCED';").fetchone()[0]
        total_count = conn.execute("SELECT COUNT(*) FROM sync_queue;").fetchone()[0]

        oldest_pending_row = conn.execute(
            "SELECT created_at_utc FROM sync_queue WHERE sync_status = 'PENDING' ORDER BY created_at_utc ASC LIMIT 1;"
        ).fetchone()
        oldest_pending = oldest_pending_row[0] if oldest_pending_row else None

        last_synced_row = conn.execute(
            "SELECT created_at_utc FROM sync_queue WHERE sync_status = 'SYNCED' ORDER BY created_at_utc DESC LIMIT 1;"
        ).fetchone()
        last_synced = last_synced_row[0] if last_synced_row else None

        return {
            "total": total_count,
            "pending": pending_count,
            "failed": failed_count,
            "synced": synced_count,
            "oldest_pending_utc": oldest_pending,
            "last_synced_utc": last_synced
        }
    finally:
        conn.close()

def get_sync_history(
    limit: int = 50,
    offset: int = 0,
    status_filter: Optional[str] = None,
    db_path: Optional[Path] = None
) -> Tuple[List[Dict[str, Any]], int]:
    """Returns paginated sync log records for the audit UI."""
    limit = min(max(1, limit), 200)
    offset = max(0, offset)

    conn = get_db_connection(db_path)
    try:
        where_sql = ""
        params: List[Any] = []
        if status_filter:
            where_sql = " WHERE sync_status = ?"
            params.append(status_filter)

        count_cur = conn.execute(f"SELECT COUNT(*) FROM sync_queue{where_sql};", params)
        total_count = count_cur.fetchone()[0]

        cur = conn.execute(
            f"SELECT * FROM sync_queue{where_sql} ORDER BY created_at_utc DESC LIMIT ? OFFSET ?;",
            params + [limit, offset]
        )
        rows = cur.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            if d.get("payload_json"):
                try:
                    d["payload"] = json.loads(d["payload_json"])
                except Exception:
                    d["payload"] = {}
            results.append(d)
        return results, total_count
    finally:
        conn.close()

def reset_failed_sync_records(db_path: Optional[Path] = None) -> int:
    """Resets all FAILED records to PENDING for immediate retry."""
    conn = get_db_connection(db_path)
    try:
        with conn:
            cur = conn.execute("""
            UPDATE sync_queue
            SET sync_status = 'PENDING', next_retry_at_utc = NULL
            WHERE sync_status = 'FAILED';
            """)
            return cur.rowcount
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# Phase 5A: PPE Incidents CRUD
# ---------------------------------------------------------------------------

def insert_ppe_incident(
    incident: Dict[str, Any], 
    db_path: Optional[Path] = None
) -> Tuple[bool, str]:
    """Inserts a confirmed 60-second PPE violation incident record into SQLite."""
    conn = get_db_connection(db_path)
    incident_id = incident.get("incident_id") or f"INC-{uuid.uuid4().hex[:8].upper()}"
    now_utc = datetime.now(timezone.utc).isoformat()
    try:
        with conn:
            conn.execute("""
            INSERT INTO ppe_incidents (
                incident_id, track_id, missing_ppe, violation_start_utc, 
                trigger_time_utc, resolved_time_utc, duration_seconds, 
                status, evidence_image_path, operator_notes, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """, (
                incident_id,
                int(incident.get("track_id", 0)),
                str(incident.get("missing_ppe", "UNKNOWN")),
                incident.get("violation_start_utc", now_utc),
                incident.get("trigger_time_utc", now_utc),
                incident.get("resolved_time_utc"),
                float(incident.get("duration_seconds", 60.0)),
                str(incident.get("status", "OPEN")),
                incident.get("evidence_image_path"),
                incident.get("operator_notes"),
                now_utc
            ))
        return True, incident_id
    except Exception as e:
        logger.error(f"Failed to insert PPE incident {incident_id}: {e}")
        return False, incident_id
    finally:
        conn.close()

def get_ppe_incidents(
    limit: int = 50,
    offset: int = 0,
    status_filter: Optional[str] = None,
    db_path: Optional[Path] = None
) -> Tuple[List[Dict[str, Any]], int]:
    """Returns paginated PPE incidents from SQLite."""
    conn = get_db_connection(db_path)
    limit = min(max(1, limit), 200)
    offset = max(0, offset)
    try:
        where_clauses = []
        params = []
        if status_filter:
            where_clauses.append("status = ?")
            params.append(status_filter)
        where_sql = f" WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        count_cur = conn.execute(f"SELECT COUNT(*) FROM ppe_incidents{where_sql};", params)
        total_count = count_cur.fetchone()[0]

        cur = conn.execute(
            f"SELECT * FROM ppe_incidents{where_sql} ORDER BY trigger_time_utc DESC LIMIT ? OFFSET ?;",
            params + [limit, offset]
        )
        rows = cur.fetchall()
        return [dict(r) for r in rows], total_count
    finally:
        conn.close()

def get_ppe_incident_by_id(
    incident_id: str, 
    db_path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Retrieves a single PPE incident by its ID."""
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute("SELECT * FROM ppe_incidents WHERE incident_id = ? LIMIT 1;", (incident_id,))
        row = cur.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def resolve_ppe_incident(
    incident_id: str, 
    resolved_time_utc: Optional[str] = None, 
    notes: Optional[str] = None, 
    db_path: Optional[Path] = None
) -> bool:
    """Marks an active PPE incident as RESOLVED when compliance is restored."""
    conn = get_db_connection(db_path)
    now_utc = resolved_time_utc or datetime.now(timezone.utc).isoformat()
    try:
        with conn:
            cur = conn.execute("""
            UPDATE ppe_incidents
            SET status = 'RESOLVED', resolved_time_utc = ?, operator_notes = COALESCE(?, operator_notes)
            WHERE incident_id = ? AND status != 'RESOLVED';
            """, (now_utc, notes, incident_id))
            return cur.rowcount > 0
    finally:
        conn.close()

def acknowledge_ppe_incident(
    incident_id: str, 
    operator_notes: Optional[str] = None, 
    db_path: Optional[Path] = None
) -> bool:
    """Acknowledges an open PPE incident."""
    conn = get_db_connection(db_path)
    try:
        with conn:
            cur = conn.execute("""
            UPDATE ppe_incidents
            SET status = 'ACKNOWLEDGED', operator_notes = ?
            WHERE incident_id = ? AND status = 'OPEN';
            """, (operator_notes, incident_id))
            return cur.rowcount > 0
    finally:
        conn.close()

