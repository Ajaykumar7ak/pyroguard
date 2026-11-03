import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
import serial
import serial.tools.list_ports
import re
import db
from telemetry import telemetry_engine

logger = logging.getLogger("pyroguard.collector")

def parse_telemetry_line(line: str) -> Optional[Dict[str, Any]]:
    """
    Parses incoming telemetry from the ESP32 in multiple supported formats:
      1. Newline-delimited JSON: {"temp_c": 28.5, ...}
      2. Human-readable text: Flame: NOT DETECTED | Buzzer: OFF | Temperature: 28.5 C | Humidity: 60.0 %
      3. CSV format from pyro_guard.ino: uptime_ms,temp,humidity,,flame,buzzer,dht_ok
    """
    if not line:
        return None

    # 1. JSON format
    if line.startswith("{") and line.endswith("}"):
        try:
            data = json.loads(line)
            # Ensure it contains at least one recognized telemetry key
            if any(k in data for k in ["temp_c", "temperature_c", "flame_detected", "humidity", "humidity_pct", "event"]):
                return data
        except Exception:
            pass

    # 2. Human-readable text format
    if "Flame:" in line and "Buzzer:" in line:
        try:
            flame_det = "Flame: DETECTED" in line
            buzzer_act = "Buzzer: ON" in line
            temp_match = re.search(r"Temperature:\s*([0-9.]+)\s*C", line)
            hum_match = re.search(r"Humidity:\s*([0-9.]+)\s*%", line)
            temp_c = float(temp_match.group(1)) if temp_match else None
            hum_pct = float(hum_match.group(1)) if hum_match else None
            return {
                "device_id": "PYRO-ESP32",
                "temp_c": temp_c,
                "humidity_pct": hum_pct,
                "flame_detected": flame_det,
                "buzzer_active": buzzer_act,
                "sensor_status": "NORMAL" if temp_c is not None else "DHT_WAIT",
                "raw_line": line
            }
        except Exception:
            pass

    # 3. CSV line format
    parts = line.split(",")
    if len(parts) >= 6:
        try:
            uptime_ms = int(parts[0]) if parts[0].isdigit() else 0
            temp_c = float(parts[1]) if parts[1].strip() else None
            hum_pct = float(parts[2]) if parts[2].strip() else None

            # Handle 7-field format (from pyro_guard.ino with empty column at index 3)
            # or standard 6-field format
            if len(parts) >= 7 and parts[3].strip() == "":
                flame_det = parts[4].strip() == "1"
                buzzer_act = parts[5].strip() == "1"
                dht_ok = parts[6].strip() == "1"
            else:
                flame_det = parts[3].strip() == "1"
                buzzer_act = parts[4].strip() == "1" if len(parts) > 4 else False
                dht_ok = parts[5].strip() == "1" if len(parts) > 5 else (temp_c is not None)

            return {
                "device_id": "PYRO-ESP32",
                "uptime_ms": uptime_ms,
                "uptime_s": uptime_ms // 1000,
                "temp_c": temp_c,
                "temperature_c": temp_c,
                "humidity_pct": hum_pct,
                "flame_detected": flame_det,
                "buzzer_active": buzzer_act,
                "buzzer_on": buzzer_act,
                "sensor_status": "NORMAL" if dht_ok else "DHT_ERROR",
                "raw_line": line
            }
        except Exception:
            pass

    return None

class SerialCollector:
    """
    Thread-safe Serial Port Collector for ESP32 Sensor Node.
    Distinguishes port open, data stream, valid telemetry, and stale states.
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._serial: Optional[serial.Serial] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False

        self.port: str = ""
        self.baud_rate: int = 115200
        self.last_error: Optional[str] = None
        
        # Telemetry metrics
        self.packets_received: int = 0
        self.bytes_received: int = 0
        self.last_packet: Optional[Dict[str, Any]] = None
        
        # Timestamps
        self.connected_since: Optional[str] = None
        self.last_reading_dt: Optional[datetime] = None
        self.last_reading_time: Optional[str] = None
        self.last_data_received_time: Optional[str] = None
        
        # Stale timeout in seconds (pyro_guard.ino emits every 2.0s)
        self.stale_timeout_s: float = 6.0

    def compute_state(self) -> str:
        """
        Determines the true operational state:
          - DISCONNECTED: Port is closed or not opened
          - WAITING FOR DATA: Port is open, but 0 valid packets have arrived
          - CONNECTED: Port is open, valid packets have arrived within stale timeout
          - STALE: Port is open, but no valid packet received for > stale_timeout_s
          - ERROR: Port encountered a communication/hardware error
        """
        if not self._running or not self._serial or not self._serial.is_open:
            if self.last_error:
                return "ERROR"
            return "DISCONNECTED"

        # Port is open
        if self.packets_received == 0:
            return "WAITING FOR DATA"

        if self.last_reading_dt is not None:
            age_s = (datetime.now(timezone.utc) - self.last_reading_dt).total_seconds()
            if age_s > self.stale_timeout_s:
                return "STALE"

        return "CONNECTED"

    def list_available_ports(self) -> List[Dict[str, str]]:
        """List all detected serial COM ports with hardware details."""
        ports = []
        for p in serial.tools.list_ports.comports():
            ports.append({
                "device": p.device,
                "description": p.description,
                "hwid": p.hwid,
                "manufacturer": getattr(p, "manufacturer", None) or "Unknown",
                "is_esp32_hint": any(hint in (p.description or "").lower() for hint in ["cp210", "ch340", "ch341", "ftdi", "usb serial", "uart", "esp32"])
            })
        return ports

    def connect(self, port: str, baud_rate: int = 115200) -> Dict[str, Any]:
        """Connect to the specified serial port with exclusive access."""
        with self._lock:
            # If already open on the same port and baud, return ok
            if self._running and self._serial and self._serial.is_open:
                if self.port == port and self.baud_rate == baud_rate:
                    return {"success": True, "message": f"Already connected to {port} @ {baud_rate}"}
                self._stop_internal()

            self.port = port
            self.baud_rate = baud_rate
            self.last_error = None
            self.packets_received = 0
            self.bytes_received = 0
            self.last_packet = None
            self.last_reading_dt = None
            self.last_reading_time = None
            self.last_data_received_time = None

            try:
                self._serial = serial.Serial(
                    port=port,
                    baudrate=baud_rate,
                    timeout=1.0,
                    write_timeout=1.0
                )
                self._running = True
                self.connected_since = datetime.now(timezone.utc).isoformat()

                # Start reader thread
                self._thread = threading.Thread(target=self._read_loop, daemon=True, name="SerialReaderThread")
                self._thread.start()

                # Update database device status
                db.upsert_device(
                    device_id="PYRO-ESP32",
                    device_type="ESP32_SENSOR_NODE",
                    connection_status="WAITING FOR DATA",
                    diagnostics={"com_port": port, "baud_rate": baud_rate}
                )

                logger.info(f"Serial port {port} opened @ {baud_rate} baud. Waiting for telemetry data...")
                return {"success": True, "message": f"Port {port} opened @ {baud_rate} baud. Waiting for sensor data..."}
            except Exception as e:
                self.last_error = str(e)
                self._stop_internal()
                db.upsert_device(
                    device_id="PYRO-ESP32",
                    device_type="ESP32_SENSOR_NODE",
                    connection_status="ERROR",
                    diagnostics={"error": str(e), "com_port": port}
                )
                logger.error(f"Failed to connect to {port}: {e}")
                return {"success": False, "error": str(e)}

    def disconnect(self) -> Dict[str, Any]:
        """Safely disconnect and release the COM port."""
        with self._lock:
            res = self._stop_internal()
            self.last_error = None
            db.upsert_device(
                device_id="PYRO-ESP32",
                device_type="ESP32_SENSOR_NODE",
                connection_status="DISCONNECTED"
            )
            return res

    def _stop_internal(self) -> Dict[str, Any]:
        self._running = False
        if self._serial:
            try:
                self._serial.close()
            except Exception as e:
                logger.warning(f"Error closing serial port: {e}")
            finally:
                self._serial = None

        return {"success": True, "message": "Disconnected and COM port released"}

    def _read_loop(self):
        """Dedicated background reader loop ensuring clean non-blocking stream ingestion."""
        while self._running:
            try:
                if not self._serial or not self._serial.is_open:
                    break

                raw_bytes = self._serial.readline()
                if not raw_bytes:
                    continue

                self.bytes_received += len(raw_bytes)
                self.last_data_received_time = datetime.now(timezone.utc).isoformat()

                line = raw_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                parsed_packet = parse_telemetry_line(line)
                if parsed_packet:
                    # Ingest via unified telemetry engine (validation, deduplication, SQLite, alarms)
                    normalized = telemetry_engine.process_reading(parsed_packet, source="serial")
                    if normalized:
                        self.last_packet = normalized
                    elif not self.last_packet:
                        self.last_packet = parsed_packet

                    self.packets_received += 1
                    self.last_reading_dt = datetime.now(timezone.utc)
                    self.last_reading_time = self.last_reading_dt.isoformat()
                    self.last_error = None
                else:
                    logger.debug(f"Non-telemetry serial line: {line}")

            except serial.SerialException as se:
                logger.error(f"Serial read exception on {self.port}: {se}")
                self.last_error = f"Device disconnected or read error: {se}"
                db.upsert_device(
                    device_id="PYRO-ESP32",
                    device_type="ESP32_SENSOR_NODE",
                    connection_status="ERROR",
                    diagnostics={"error": self.last_error}
                )
                break
            except Exception as e:
                logger.error(f"Unexpected reader exception: {e}")
                self.last_error = str(e)
                db.upsert_device(
                    device_id="PYRO-ESP32",
                    device_type="ESP32_SENSOR_NODE",
                    connection_status="ERROR",
                    diagnostics={"error": str(e)}
                )
                break

        with self._lock:
            if self._serial:
                try:
                    self._serial.close()
                except Exception:
                    pass
                self._serial = None
            self._running = False

    def get_status(self) -> Dict[str, Any]:
        """Get live connection state and telemetry statistics."""
        current_state = self.compute_state()
        now_dt = datetime.now(timezone.utc)
        reading_age_s = None
        if self.last_reading_dt is not None:
            reading_age_s = round((now_dt - self.last_reading_dt).total_seconds(), 1)

        is_open = bool(self._running and self._serial and self._serial.is_open)

        return {
            "status": current_state,
            "is_port_open": is_open,
            "port": self.port,
            "baud_rate": self.baud_rate,
            "packets_received": self.packets_received,
            "bytes_received": self.bytes_received,
            "connected_since": self.connected_since,
            "last_reading_time": self.last_reading_time,
            "last_data_received_time": self.last_data_received_time,
            "reading_age_seconds": reading_age_s,
            "last_packet": self.last_packet,
            "last_error": self.last_error,
            "is_stale": current_state == "STALE",
            "is_waiting_data": current_state == "WAITING FOR DATA",
            "is_connected": current_state == "CONNECTED"
        }

# Global singleton collector instance
collector = SerialCollector()
