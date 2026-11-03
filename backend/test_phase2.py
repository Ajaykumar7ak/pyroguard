import os
import sys
import time
import json
import uuid
import sqlite3
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Ensure backend path is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

import db
from telemetry import TelemetryEngine
from collector import parse_telemetry_line

class Phase2TelemetryAndDatabaseTests(unittest.TestCase):
    def setUp(self):
        # Create a dedicated isolated test database in backend directory
        self.test_db_path = Path(__file__).resolve().parent / "test_pyroguard.db"
        if self.test_db_path.exists():
            try:
                self.test_db_path.unlink()
            except Exception:
                pass
        db.init_db(self.test_db_path)
        self.engine = TelemetryEngine(db_path=self.test_db_path)

    def tearDown(self):
        if self.test_db_path.exists():
            try:
                self.test_db_path.unlink()
            except Exception:
                pass

    def test_01_valid_csv_telemetry_ingestion(self):
        """Test 1: Valid CSV telemetry ingestion from current firmware formats."""
        # 7-field CSV with empty field from pyro_guard.ino: uptime_ms,temp,hum,,flame,buzzer,dht_ok
        line_7 = "18200,29.4,62.5,,0,0,1"
        parsed = parse_telemetry_line(line_7)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["uptime_ms"], 18200)
        self.assertEqual(parsed["temp_c"], 29.4)
        self.assertEqual(parsed["humidity_pct"], 62.5)
        self.assertFalse(parsed["flame_detected"])
        self.assertFalse(parsed["buzzer_on"])

        # Ingest through engine
        saved = self.engine.process_reading(parsed, source="serial")
        self.assertIsNotNone(saved)
        self.assertEqual(saved["validation_status"], "VALID")
        self.assertEqual(saved["temperature_c"], 29.4)
        self.assertEqual(saved["humidity_pct"], 62.5)

        # Standard 6-field CSV: uptime_ms,temp,hum,flame,buzzer,dht_ok
        line_6 = "20500,30.1,65.0,0,0,1"
        parsed_6 = parse_telemetry_line(line_6)
        self.assertIsNotNone(parsed_6)
        self.assertEqual(parsed_6["uptime_ms"], 20500)
        self.assertEqual(parsed_6["temp_c"], 30.1)
        saved_6 = self.engine.process_reading(parsed_6, source="serial")
        self.assertIsNotNone(saved_6)
        self.assertEqual(saved_6["temperature_c"], 30.1)

    def test_02_valid_json_telemetry_ingestion(self):
        """Test 2: Valid JSON telemetry ingestion."""
        json_line = json.dumps({
            "device_id": "PYRO-ESP32",
            "uptime_ms": 32100,
            "temp_c": 31.8,
            "humidity_pct": 78.8,
            "flame_detected": False,
            "buzzer_active": False
        })
        parsed = parse_telemetry_line(json_line)
        self.assertIsNotNone(parsed)
        saved = self.engine.process_reading(parsed, source="serial")
        self.assertIsNotNone(saved)
        self.assertEqual(saved["device_id"], "PYRO-ESP32")
        self.assertEqual(saved["temperature_c"], 31.8)
        self.assertEqual(saved["humidity_pct"], 78.8)
        self.assertFalse(saved["flame_detected"])
        self.assertEqual(saved["validation_status"], "VALID")

    def test_03_invalid_and_incomplete_sensor_payloads(self):
        """Test 3: Handling invalid and incomplete payloads without fabricating data."""
        # 1. Out-of-bounds temperature (> 125.0 C)
        out_of_bounds = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 100,
            "temp_c": 999.0,
            "humidity_pct": 50.0,
            "flame_detected": False
        }
        res = self.engine.process_reading(out_of_bounds)
        self.assertIsNone(res, "Out-of-bounds temperature must be rejected")

        # 2. Out-of-bounds humidity (> 100%)
        out_of_bounds_hum = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 200,
            "temp_c": 25.0,
            "humidity_pct": 150.0,
            "flame_detected": False
        }
        res_hum = self.engine.process_reading(out_of_bounds_hum)
        self.assertIsNone(res_hum, "Out-of-bounds humidity must be rejected")

        # 3. Missing DHT readings (e.g. DHT22 failed on hardware, but flame is active)
        # Should preserve valid flame/buzzer with 'DEGRADED' validation status
        missing_dht = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 300,
            "temp_c": None,
            "humidity_pct": None,
            "flame_detected": True,
            "buzzer_on": True
        }
        res_deg = self.engine.process_reading(missing_dht)
        self.assertIsNotNone(res_deg)
        self.assertEqual(res_deg["validation_status"], "DEGRADED")
        self.assertIsNone(res_deg["temperature_c"])
        self.assertIsNone(res_deg["humidity_pct"])
        self.assertTrue(res_deg["flame_detected"])
        self.assertTrue(res_deg["buzzer_on"])

    def test_04_duplicate_reading_handling(self):
        """Test 4: Duplicate reading handling and deduplication."""
        packet1 = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 45000,
            "temp_c": 28.0,
            "humidity_pct": 60.0,
            "flame_detected": False,
            "buzzer_on": False
        }
        first = self.engine.process_reading(packet1)
        self.assertIsNotNone(first)

        # Same packet submitted again with exact same uptime_ms
        duplicate = self.engine.process_reading(packet1)
        self.assertIsNone(duplicate, "Duplicate packet with matching uptime_ms must be skipped")

        # Verify only 1 reading exists in SQLite database
        readings, count = db.get_sensor_readings_history(db_path=self.test_db_path)
        self.assertEqual(count, 1)

    def test_05_sqlite_persistence_across_backend_restart(self):
        """Test 5: SQLite persistence across simulated backend restart."""
        # Insert 3 readings
        for i in range(3):
            packet = {
                "device_id": "PYRO-ESP32",
                "uptime_ms": 50000 + (i * 2000),
                "temp_c": 25.0 + i,
                "humidity_pct": 50.0 + i,
                "flame_detected": False,
                "buzzer_on": False
            }
            self.engine.process_reading(packet)

        # Re-initialize engine with the same database file (simulating backend process restart)
        new_engine = TelemetryEngine(db_path=self.test_db_path)
        latest = db.get_latest_sensor_reading(db_path=self.test_db_path)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["temperature_c"], 27.0)

        readings, count = db.get_sensor_readings_history(db_path=self.test_db_path)
        self.assertEqual(count, 3)

    def test_06_history_filtering_and_pagination(self):
        """Test 6: Pagination and date-range filtering."""
        base_time = datetime(2026, 10, 17, 10, 0, 0, tzinfo=timezone.utc)
        
        # Insert 10 readings spaced 1 minute apart
        for i in range(10):
            ts = (base_time + timedelta(minutes=i)).isoformat()
            reading = {
                "reading_id": str(uuid.uuid4()),
                "device_id": "PYRO-ESP32" if i < 8 else "PYRO-NODE-2",
                "timestamp_utc": ts,
                "uptime_ms": 100000 + (i * 60000),
                "temperature_c": 22.0 + i,
                "humidity_pct": 55.0,
                "flame_detected": 0,
                "buzzer_on": 0,
                "source": "serial",
                "validation_status": "VALID"
            }
            db.insert_sensor_reading(reading, db_path=self.test_db_path)

        # Test pagination limit 4 offset 0
        p1, total = db.get_sensor_readings_history(limit=4, offset=0, db_path=self.test_db_path)
        self.assertEqual(total, 10)
        self.assertEqual(len(p1), 4)

        # Test pagination limit 4 offset 4
        p2, total2 = db.get_sensor_readings_history(limit=4, offset=4, db_path=self.test_db_path)
        self.assertEqual(len(p2), 4)
        self.assertNotEqual(p1[0]["reading_id"], p2[0]["reading_id"])

        # Test date filter
        t_start = (base_time + timedelta(minutes=3)).isoformat()
        t_end = (base_time + timedelta(minutes=6)).isoformat()
        filtered, f_total = db.get_sensor_readings_history(
            start_time=t_start, end_time=t_end, db_path=self.test_db_path
        )
        self.assertEqual(f_total, 4)

        # Test device filter
        node2_readings, n2_total = db.get_sensor_readings_history(
            device_id="PYRO-NODE-2", db_path=self.test_db_path
        )
        self.assertEqual(n2_total, 2)

    def test_07_alarm_creation_without_duplicate_active_incidents(self):
        """Test 7: Alarm creation, deduplication of active incidents, and resolution."""
        # 1. Flame detected -> Creates active alarm
        p_flame_1 = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 200000,
            "temp_c": 29.0,
            "humidity_pct": 50.0,
            "flame_detected": True,
            "buzzer_on": True
        }
        self.engine.process_reading(p_flame_1)

        active_alarms, count = db.get_alarm_events(active_only=True, db_path=self.test_db_path)
        self.assertEqual(count, 1)
        first_event_id = active_alarms[0]["event_id"]
        self.assertEqual(active_alarms[0]["event_type"], "FLAME_HAZARD")
        self.assertEqual(active_alarms[0]["severity"], "CRITICAL")
        self.assertTrue(active_alarms[0]["is_active"])

        # 2. Flame still detected in subsequent readings -> MUST NOT create duplicate alarm
        p_flame_2 = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 202000,
            "temp_c": 29.5,
            "humidity_pct": 50.0,
            "flame_detected": True,
            "buzzer_on": True
        }
        self.engine.process_reading(p_flame_2)

        _, total_alarms = db.get_alarm_events(active_only=False, db_path=self.test_db_path)
        self.assertEqual(total_alarms, 1, "Duplicate alarm must not be created while incident is active")

        # 3. Flame cleared -> Resolves the active alarm
        p_clear = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 204000,
            "temp_c": 28.5,
            "humidity_pct": 52.0,
            "flame_detected": False,
            "buzzer_on": False
        }
        self.engine.process_reading(p_clear)

        active_after, active_count = db.get_alarm_events(active_only=True, db_path=self.test_db_path)
        self.assertEqual(active_count, 0, "Alarm must be marked resolved when flame clears")

        # Verify resolution timestamp was recorded on the event
        all_alarms, _ = db.get_alarm_events(active_only=False, db_path=self.test_db_path)
        self.assertEqual(len(all_alarms), 1)
        self.assertFalse(all_alarms[0]["is_active"])
        self.assertIsNotNone(all_alarms[0]["end_time_utc"])

    def test_08_multiple_dashboard_clients_receiving_updates(self):
        """Test 8: Multiple dashboard client subscribers receiving telemetry updates."""
        received_client_1 = []
        received_client_2 = []

        def client_1_callback(reading):
            received_client_1.append(reading)

        def client_2_callback(reading):
            received_client_2.append(reading)

        self.engine.register_listener(client_1_callback)
        self.engine.register_listener(client_2_callback)

        packet = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 300000,
            "temp_c": 26.5,
            "humidity_pct": 58.0,
            "flame_detected": False,
            "buzzer_on": False
        }
        self.engine.process_reading(packet)

        self.assertEqual(len(received_client_1), 1)
        self.assertEqual(len(received_client_2), 1)
        self.assertEqual(received_client_1[0]["temperature_c"], 26.5)
        self.assertEqual(received_client_2[0]["temperature_c"], 26.5)

    def test_09_sync_queue_durable_staging(self):
        """Test 9: Verify durable synchronization queue records are created for future cloud backup."""
        packet = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 400000,
            "temp_c": 27.2,
            "humidity_pct": 61.0,
            "flame_detected": False,
            "buzzer_on": False
        }
        saved = self.engine.process_reading(packet)
        self.assertIsNotNone(saved)

        # Check sync_queue table in SQLite
        conn = db.get_db_connection(self.test_db_path)
        try:
            row = conn.execute("SELECT * FROM sync_queue WHERE payload_reference = ?;", (saved["reading_id"],)).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["record_type"], "sensor_reading")
            self.assertEqual(row["sync_status"], "PENDING")
            self.assertEqual(row["attempt_count"], 0)
            payload = json.loads(row["payload_json"])
            self.assertEqual(payload["reading_id"], saved["reading_id"])
        finally:
            conn.close()

    def test_10_database_status_and_health(self):
        """Test 10: Database status metadata and WAL verification."""
        stat = db.get_database_status(self.test_db_path)
        self.assertEqual(stat["status"], "ONLINE")
        self.assertEqual(stat["integrity"], "OK")
        self.assertEqual(stat["journal_mode"], "WAL")
        self.assertTrue(stat["local_first_offline_ready"])

if __name__ == "__main__":
    unittest.main()
