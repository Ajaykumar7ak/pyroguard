import uuid
import logging
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Callable, List
from pathlib import Path

import db
from config import load_settings

logger = logging.getLogger("pyroguard.telemetry")

class TelemetryEngine:
    """
    Unified Telemetry Normalization, Validation, Deduplication,
    and Alarm Event Transition Engine for PYROGUARD-H.
    """
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path
        # Cache of active alarms: key -> (event_id, event_type, start_time_utc)
        # key: (device_id, event_type)
        self._active_alarms: Dict[Tuple[str, str], Dict[str, Any]] = {}
        # Cache of last seen reading for deduplication: device_id -> dict
        self._last_readings: Dict[str, Dict[str, Any]] = {}
        # Broadcast listeners: list of callable(reading_dict) or async queues
        self._listeners: List[Callable[[Dict[str, Any]], None]] = []

    def register_listener(self, listener: Callable[[Dict[str, Any]], None]):
        """Register a callback invoked whenever a new reading is saved."""
        if listener not in self._listeners:
            self._listeners.append(listener)

    def unregister_listener(self, listener: Callable[[Dict[str, Any]], None]):
        if listener in self._listeners:
            self._listeners.remove(listener)

    def validate_reading(self, raw_data: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
        """
        Validates telemetry ranges and normalizes field types.
        - Temperature valid range: -40.0°C to 125.0°C (DHT22 specification)
        - Humidity valid range: 0.0% to 100.0%
        - Missing/failed DHT values preserve valid flame/buzzer readings with 'DEGRADED' status
        - Malformed/corrupted readings outside physical bounds return (False, 'INVALID', ...)
        """
        device_id = str(raw_data.get("device_id") or "PYRO-ESP32").strip()
        
        # Uptime extraction (support uptime_ms or uptime_s)
        uptime_ms = None
        if "uptime_ms" in raw_data and raw_data["uptime_ms"] is not None:
            try:
                uptime_ms = int(raw_data["uptime_ms"])
            except (ValueError, TypeError):
                pass
        elif "uptime_s" in raw_data and raw_data["uptime_s"] is not None:
            try:
                uptime_ms = int(float(raw_data["uptime_s"]) * 1000)
            except (ValueError, TypeError):
                pass

        # Temperature extraction and validation
        temp_val = raw_data.get("temp_c") if "temp_c" in raw_data else raw_data.get("temperature_c")
        temp_c: Optional[float] = None
        temp_valid = False
        if temp_val is not None and str(temp_val).strip() != "":
            try:
                f_temp = float(temp_val)
                if -40.0 <= f_temp <= 125.0:
                    temp_c = round(f_temp, 1)
                    temp_valid = True
                else:
                    logger.warning(f"Temperature out of physical DHT22 bounds: {f_temp}°C")
                    return False, "INVALID_TEMPERATURE_OUT_OF_BOUNDS", {}
            except (ValueError, TypeError):
                return False, "MALFORMED_TEMPERATURE", {}

        # Humidity extraction and validation
        hum_val = raw_data.get("humidity_pct") if "humidity_pct" in raw_data else raw_data.get("humidity")
        hum_pct: Optional[float] = None
        hum_valid = False
        if hum_val is not None and str(hum_val).strip() != "":
            try:
                f_hum = float(hum_val)
                if 0.0 <= f_hum <= 100.0:
                    hum_pct = round(f_hum, 1)
                    hum_valid = True
                else:
                    logger.warning(f"Humidity out of physical bounds: {f_hum}%")
                    return False, "INVALID_HUMIDITY_OUT_OF_BOUNDS", {}
            except (ValueError, TypeError):
                return False, "MALFORMED_HUMIDITY", {}

        # Flame detection
        flame_val = raw_data.get("flame_detected", False)
        flame_detected = bool(flame_val is True or str(flame_val).strip() in ["1", "true", "True"])

        # Buzzer status
        buzzer_val = raw_data.get("buzzer_on") if "buzzer_on" in raw_data else raw_data.get("buzzer_active", False)
        buzzer_on = bool(buzzer_val is True or str(buzzer_val).strip() in ["1", "true", "True"])

        # Validation status categorization
        if temp_valid and hum_valid:
            validation_status = "VALID"
        elif temp_c is None and hum_pct is None:
            # Preserving valid flame & buzzer readings when DHT sensor fails or is initializing
            validation_status = "DEGRADED"
        else:
            validation_status = "PARTIAL"

        normalized = {
            "reading_id": str(uuid.uuid4()),
            "device_id": device_id,
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "uptime_ms": uptime_ms,
            "temperature_c": temp_c,
            "humidity_pct": hum_pct,
            "flame_detected": flame_detected,
            "buzzer_on": buzzer_on,
            "source": raw_data.get("source", "serial"),
            "validation_status": validation_status
        }

        return True, validation_status, normalized

    def is_duplicate(self, reading: Dict[str, Any]) -> bool:
        """
        Deduplication check:
        Avoid storing duplicate records when identical packet is re-submitted or re-transmitted.
        """
        device_id = reading.get("device_id", "PYRO-ESP32")
        last = self._last_readings.get(device_id)
        if not last:
            return False

        # If both have a non-zero uptime_ms and they match exactly, it's a duplicate
        if reading.get("uptime_ms") and last.get("uptime_ms"):
            if reading["uptime_ms"] == last["uptime_ms"]:
                return True

        # If values are identical and timestamp difference is under 1.0 second
        same_readings = (
            reading.get("temperature_c") == last.get("temperature_c") and
            reading.get("humidity_pct") == last.get("humidity_pct") and
            reading.get("flame_detected") == last.get("flame_detected") and
            reading.get("buzzer_on") == last.get("buzzer_on")
        )
        if same_readings:
            try:
                now_dt = datetime.fromisoformat(reading["timestamp_utc"])
                last_dt = datetime.fromisoformat(last["timestamp_utc"])
                if (now_dt - last_dt).total_seconds() < 1.0:
                    return True
            except Exception:
                pass

        return False

    def handle_alarm_transitions(self, reading: Dict[str, Any]):
        """
        Monitors flame detection transitions and temperature threshold violations.
        - Creates an alarm when hazard condition begins.
        - Avoids duplicate alarms for repeated sensor packets while incident remains active.
        - Resolves the active alarm when hazard condition returns to normal.
        - Clearly distinguishes hardware flame status from software-generated warnings.
        """
        device_id = reading["device_id"]
        ts_utc = reading["timestamp_utc"]
        flame_detected = reading["flame_detected"]
        temp_c = reading.get("temperature_c")

        # 1. Flame Hazard Transition (Hardware Sensor Reported)
        flame_key = (device_id, "FLAME_HAZARD")
        active_flame = self._active_alarms.get(flame_key)
        if not active_flame:
            # Check DB in case backend restarted
            active_flame = db.get_active_alarm_by_type(device_id, "FLAME_HAZARD", db_path=self.db_path)
            if active_flame:
                self._active_alarms[flame_key] = active_flame

        if flame_detected:
            if not active_flame:
                # Trigger new critical alarm incident
                alarm_data = {
                    "event_id": str(uuid.uuid4()),
                    "device_id": device_id,
                    "event_type": "FLAME_HAZARD",
                    "severity": "CRITICAL",
                    "source": "hardware_sensor",
                    "start_time_utc": ts_utc
                }
                success, event_id = db.create_alarm_event(alarm_data, db_path=self.db_path)
                if success:
                    alarm_data["event_id"] = event_id
                    self._active_alarms[flame_key] = alarm_data
                    logger.warning(f"CRITICAL ALARM CREATED: Flame detected on {device_id} (Event: {event_id})")
        else:
            if active_flame:
                # Resolve active alarm incident
                event_id = active_flame["event_id"]
                db.resolve_alarm_event(event_id, end_time_utc=ts_utc, db_path=self.db_path)
                self._active_alarms.pop(flame_key, None)
                logger.info(f"ALARM RESOLVED: Flame clear on {device_id} (Event: {event_id})")

        # 2. High Temperature Alert Transition (Software Configured Threshold)
        settings = load_settings()
        high_temp_threshold = settings.dht_high_temp_threshold
        temp_key = (device_id, "HIGH_TEMPERATURE")
        active_temp = self._active_alarms.get(temp_key)
        if not active_temp:
            active_temp = db.get_active_alarm_by_type(device_id, "HIGH_TEMPERATURE", db_path=self.db_path)
            if active_temp:
                self._active_alarms[temp_key] = active_temp

        if temp_c is not None and temp_c >= high_temp_threshold:
            if not active_temp:
                alarm_data = {
                    "event_id": str(uuid.uuid4()),
                    "device_id": device_id,
                    "event_type": "HIGH_TEMPERATURE",
                    "severity": "WARNING",
                    "source": "software_threshold",
                    "start_time_utc": ts_utc
                }
                success, event_id = db.create_alarm_event(alarm_data, db_path=self.db_path)
                if success:
                    alarm_data["event_id"] = event_id
                    self._active_alarms[temp_key] = alarm_data
                    logger.warning(f"WARNING ALARM CREATED: High temp {temp_c}°C on {device_id} (Event: {event_id})")
        elif temp_c is not None and temp_c < high_temp_threshold:
            if active_temp:
                event_id = active_temp["event_id"]
                db.resolve_alarm_event(event_id, end_time_utc=ts_utc, db_path=self.db_path)
                self._active_alarms.pop(temp_key, None)
                logger.info(f"ALARM RESOLVED: High temp normalized {temp_c}°C on {device_id} (Event: {event_id})")

    def process_reading(self, raw_data: Dict[str, Any], source: str = "serial") -> Optional[Dict[str, Any]]:
        """
        Main telemetry ingestion pipeline:
          1. Normalizes and validates incoming sensor payload.
          2. Rejects malformed / out-of-bounds payloads.
          3. Checks deduplication.
          4. Persists valid reading to SQLite database.
          5. Processes alarm transitions (flame & temperature).
          6. Updates device status in database.
          7. Broadcasts to connected subscribers.
        """
        raw_data["source"] = source
        is_valid, status_code, normalized = self.validate_reading(raw_data)
        if not is_valid:
            logger.debug(f"Rejected invalid sensor reading: {status_code} - {raw_data}")
            return None

        # Deduplication
        if self.is_duplicate(normalized):
            logger.debug(f"Skipped duplicate reading for device {normalized['device_id']}")
            return None

        # Save to SQLite database
        success, reading_id = db.insert_sensor_reading(normalized, db_path=self.db_path)
        if not success:
            logger.warning(f"Failed to persist reading to database: {reading_id}")
            return None

        normalized["reading_id"] = reading_id
        self._last_readings[normalized["device_id"]] = normalized

        # Handle alarm transitions
        self.handle_alarm_transitions(normalized)

        # Update device record
        db.upsert_device(
            device_id=normalized["device_id"],
            device_type="ESP32_SENSOR_NODE",
            connection_status="CONNECTED",
            last_reading_utc=normalized["timestamp_utc"],
            diagnostics={
                "uptime_ms": normalized.get("uptime_ms"),
                "source": source,
                "validation_status": normalized.get("validation_status")
            },
            db_path=self.db_path
        )

        # Broadcast to listeners (e.g. WebSocket clients)
        for listener in list(self._listeners):
            try:
                listener(normalized)
            except Exception as e:
                logger.error(f"Error notifying telemetry listener: {e}")

        return normalized

# Global singleton telemetry engine
telemetry_engine = TelemetryEngine()
