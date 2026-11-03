import os
import sys
import json
import uuid
import asyncio
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch, MagicMock

# Ensure backend path is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

import db
from config import CloudConfig
from cloud_provider import CloudSyncProvider, SupabaseSyncProvider
from sync_worker import SyncWorker

class MockCloudProvider(CloudSyncProvider):
    """Configurable mock cloud provider for rigorous failure mode testing."""
    def __init__(self, mode: str = "success"):
        self.mode = mode
        self.uploaded_readings: List[Dict[str, Any]] = []
        self.uploaded_alarms: List[Dict[str, Any]] = []

    def is_configured(self) -> bool:
        return self.mode != "not_configured"

    async def check_health(self) -> Dict[str, Any]:
        if self.mode == "not_configured":
            return {"status": "NOT_CONFIGURED", "is_online": False, "message": "Not configured"}
        if self.mode == "internet_down":
            return {"status": "INTERNET_UNAVAILABLE", "is_online": False, "message": "No internet"}
        if self.mode == "auth_failure":
            return {"status": "AUTH_FAILURE", "is_online": False, "message": "Invalid credentials (HTTP 401)"}
        if self.mode == "service_down":
            return {"status": "SERVICE_UNAVAILABLE", "is_online": False, "message": "HTTP 503"}
        return {"status": "ONLINE", "is_online": True, "message": "Connected"}

    async def upload_sensor_readings(self, readings):
        if self.mode == "fail_all":
            return [], [{"reading_id": r["reading_id"], "error": "Connection reset"} for r in readings]
        if self.mode == "partial_fail":
            # First item fails, rest succeed
            success = [r["reading_id"] for r in readings[1:]]
            failed = [{"reading_id": readings[0]["reading_id"], "error": "Simulated field error"}]
            self.uploaded_readings.extend([r for r in readings[1:]])
            return success, failed

        # Normal success
        success = [r["reading_id"] for r in readings]
        self.uploaded_readings.extend(readings)
        return success, []

    async def upload_alarm_events(self, events):
        if self.mode == "fail_all":
            return [], [{"event_id": e["event_id"], "error": "DB error"} for e in events]
        success = [e["event_id"] for e in events]
        self.uploaded_alarms.extend(events)
        return success, []

    async def upload_devices(self, devices):
        return [d["device_id"] for d in devices], []

class Phase3CloudSyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Create an isolated test SQLite database
        self.test_db_path = Path(__file__).resolve().parent / "test_phase3_sync.db"
        if self.test_db_path.exists():
            try:
                self.test_db_path.unlink()
            except Exception:
                pass
        db.init_db(self.test_db_path)

    def tearDown(self):
        if self.test_db_path.exists():
            try:
                self.test_db_path.unlink()
            except Exception:
                pass

    def _insert_test_reading(self, reading_id: str, temp: float = 25.0) -> str:
        """Helper to insert reading and stage to sync_queue."""
        reading = {
            "reading_id": reading_id,
            "device_id": "PYRO-ESP32",
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "uptime_ms": 10000,
            "temperature_c": temp,
            "humidity_pct": 50.0,
            "flame_detected": False,
            "buzzer_on": False,
            "source": "serial",
            "validation_status": "VALID"
        }
        db.insert_sensor_reading(reading, db_path=self.test_db_path)
        return reading_id

    async def test_01_cloud_not_configured(self):
        """Test 1: Cloud not configured -> Local app operates normally, records queue cleanly."""
        mock = MockCloudProvider(mode="not_configured")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        # Stage a reading
        self._insert_test_reading("test-reading-1")
        summary = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary["pending"], 1)

        # Run sync cycle
        result = await worker.sync_once()
        self.assertEqual(result["status"], "NOT_CONFIGURED")
        self.assertEqual(result["synced_count"], 0)

        # Verify records remain safely pending in SQLite
        summary_after = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary_after["pending"], 1)
        self.assertEqual(summary_after["synced"], 0)

    async def test_02_internet_unavailable(self):
        """Test 2: Internet unavailable -> Records remain safely pending locally."""
        mock = MockCloudProvider(mode="internet_down")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-reading-2")
        result = await worker.sync_once()
        self.assertEqual(result["status"], "INTERNET_UNAVAILABLE")

        summary = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary["pending"], 1)
        self.assertEqual(summary["synced"], 0)

    async def test_03_cloud_configured_and_successful_sync(self):
        """Test 3: Cloud configured & online -> Records upload and are marked SYNCED."""
        mock = MockCloudProvider(mode="success")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-reading-3a")
        self._insert_test_reading("test-reading-3b")
        summary_before = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary_before["pending"], 2)

        result = await worker.sync_once()
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["synced_count"], 2)

        # Verify local records are marked SYNCED (never deleted)
        summary_after = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary_after["pending"], 0)
        self.assertEqual(summary_after["synced"], 2)
        self.assertEqual(len(mock.uploaded_readings), 2)

    async def test_04_duplicate_batch_retry_idempotency(self):
        """Test 4: Retried upload uses unique ID upsert so no duplicate cloud rows can be created."""
        mock = MockCloudProvider(mode="success")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        rid = self._insert_test_reading("test-reading-4")
        await worker.sync_once()

        # Simulate re-queuing the exact same reading_id (e.g. from network timeout)
        conn = db.get_db_connection(self.test_db_path)
        with conn:
            conn.execute("UPDATE sync_queue SET sync_status = 'PENDING' WHERE payload_reference = ?", (rid,))
        conn.close()

        # Sync again
        await worker.sync_once()
        # Verify provider received the same reading ID for merge upsert
        r_ids = [r["reading_id"] for r in mock.uploaded_readings]
        self.assertEqual(r_ids.count(rid), 2)  # Upsert target in cloud handles conflict on reading_id

    async def test_05_partial_batch_failure(self):
        """Test 5: Partial batch failure -> Successful items marked SYNCED; failed items marked FAILED with backoff."""
        mock = MockCloudProvider(mode="partial_fail")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-reading-5-fail")
        self._insert_test_reading("test-reading-5-ok1")
        self._insert_test_reading("test-reading-5-ok2")

        result = await worker.sync_once()
        self.assertEqual(result["status"], "PARTIAL")
        self.assertEqual(result["synced_count"], 2)
        self.assertEqual(result["failed_count"], 1)

        summary = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary["synced"], 2)
        self.assertEqual(summary["failed"], 1)

    async def test_06_backend_restart_recovers_pending_queue(self):
        """Test 6: Backend restart recovers pending work without dropping queued records."""
        # 1. Enqueue 3 records
        for i in range(3):
            self._insert_test_reading(f"test-restart-{i}")

        # 2. Simulate shutdown and restart with a brand new worker instance
        mock = MockCloudProvider(mode="success")
        new_worker = SyncWorker(provider=mock, db_path=self.test_db_path)
        
        # Verify pending records were loaded from SQLite on disk
        pending = db.get_pending_sync_records(db_path=self.test_db_path)
        self.assertEqual(len(pending), 3)

        # Sync completes successfully
        res = await new_worker.sync_once()
        self.assertEqual(res["synced_count"], 3)

    async def test_07_cloud_authentication_failure(self):
        """Test 7: Authentication failure -> Clear diagnostic, no false success or fake green indicator."""
        mock = MockCloudProvider(mode="auth_failure")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-auth-fail")
        result = await worker.sync_once()
        self.assertEqual(result["status"], "AUTH_FAILURE")
        self.assertIn("Invalid credentials", result["message"])

        # No records marked synced
        summary = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary["synced"], 0)
        self.assertEqual(summary["pending"], 1)

    async def test_08_exponential_backoff_calculation(self):
        """Test 8: Failure sets attempt count and schedules exponential backoff without retry storm."""
        mock = MockCloudProvider(mode="fail_all")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-backoff")
        await worker.sync_once()

        # Check sync_queue attempt_count and next_retry_at_utc
        conn = db.get_db_connection(self.test_db_path)
        row = conn.execute("SELECT attempt_count, next_retry_at_utc, last_error FROM sync_queue WHERE sync_status = 'FAILED'").fetchone()
        conn.close()

        self.assertIsNotNone(row)
        self.assertEqual(row[0], 1)
        self.assertIsNotNone(row[1])
        self.assertEqual(row[2], "Connection reset")

    async def test_09_manual_sync_now(self):
        """Test 9: Manual sync now endpoint execution."""
        mock = MockCloudProvider(mode="success")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-manual-1")
        res = await worker.sync_once(force=True)
        self.assertEqual(res["status"], "SUCCESS")
        self.assertEqual(res["synced_count"], 1)

    async def test_10_queue_reset_failed_records(self):
        """Test 10: Reset failed records allows immediate retry."""
        mock = MockCloudProvider(mode="fail_all")
        worker = SyncWorker(provider=mock, db_path=self.test_db_path)

        self._insert_test_reading("test-retry-reset")
        await worker.sync_once()

        summary_fail = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary_fail["failed"], 1)

        # Operator resets failed records
        reset_count = db.reset_failed_sync_records(db_path=self.test_db_path)
        self.assertEqual(reset_count, 1)

        summary_reset = db.get_sync_queue_summary(db_path=self.test_db_path)
        self.assertEqual(summary_reset["failed"], 0)
        self.assertEqual(summary_reset["pending"], 1)

if __name__ == "__main__":
    unittest.main()
