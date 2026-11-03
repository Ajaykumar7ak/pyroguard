import os
import asyncio
import logging
import socket
import time
from pathlib import Path
from typing import Optional, Dict, Any, List
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, Response as RawResponse, FileResponse
from pydantic import BaseModel, Field

from config import load_settings, save_settings, reset_settings, AppSettings
from collector import collector
import db
from telemetry import telemetry_engine
from sync_worker import sync_worker
from ppe_engine import PPEInferenceEngine

# Forward reference for global engine
ppe_engine: Optional[PPEInferenceEngine] = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("pyroguard.main")

# Global event loop reference for thread-safe cross-thread WebSocket broadcasting
main_loop: Optional[asyncio.AbstractEventLoop] = None

class ConnectionManager:
    """Manages active WebSocket connections for real-time telemetry streaming."""
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Active clients: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        logger.info(f"WebSocket client disconnected. Active clients: {len(self.active_connections)}")

    async def broadcast(self, message: Dict[str, Any]):
        async with self._lock:
            disconnected = []
            for connection in self.active_connections:
                try:
                    await connection.send_json(message)
                except Exception:
                    disconnected.append(connection)
            for dead in disconnected:
                if dead in self.active_connections:
                    self.active_connections.remove(dead)

manager = ConnectionManager()

def broadcast_telemetry_sync(reading: Dict[str, Any]):
    """Callback invoked by TelemetryEngine whenever a valid reading is saved to SQLite."""
    global main_loop
    if main_loop and main_loop.is_running():
        try:
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"type": "telemetry", "data": reading}),
                main_loop
            )
        except Exception as e:
            logger.debug(f"Could not dispatch async broadcast: {e}")

telemetry_engine.register_listener(broadcast_telemetry_sync)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global main_loop
    main_loop = asyncio.get_running_loop()
    # Initialize SQLite database schema and indexes safely
    db.init_db()
    logger.info("PYROGUARD-H SQLite Database initialized with WAL mode and safe indexes.")
    # Start background 30-second cloud sync worker
    sync_worker.start()
    # Start background PPE inference engine
    if ppe_engine:
        ppe_engine.start()
        camera_hub.ensure_capture_loop()
    yield
    # Graceful worker shutdown
    if ppe_engine:
        ppe_engine.stop()
    sync_worker.stop()

app = FastAPI(
    title="PYROGUARD-H Local Hardware Integration Server",
    description="Local service bridging ESP32 USB Serial, SQLite persistence, and ESP32-CAM video feeds to the React Dashboard",
    version="2.0.0",
    lifespan=lifespan
)

# Enable CORS for local React development and network clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectRequest(BaseModel):
    port: str
    baud_rate: int = 115200

class CameraTestRequest(BaseModel):
    camera_ip: Optional[str] = None
    stream_url: Optional[str] = None

class TelemetrySubmission(BaseModel):
    device_id: Optional[str] = "PYRO-ESP32"
    uptime_ms: Optional[int] = None
    temperature_c: Optional[float] = None
    humidity_pct: Optional[float] = None
    flame_detected: bool = False
    buzzer_on: bool = False
    source: Optional[str] = "web_serial"

class AlarmAcknowledgeRequest(BaseModel):
    notes: Optional[str] = None

class PPEConfigRequest(BaseModel):
    target_fps: Optional[float] = None
    conf_threshold: Optional[float] = None
    violation_threshold_sec: Optional[float] = None
    required_categories: Optional[List[str]] = None

class PPEIncidentAcknowledgeRequest(BaseModel):
    notes: Optional[str] = None

# ---------------------------------------------------------------------------
# Health & Status
# ---------------------------------------------------------------------------
@app.get("/api/health")
def get_health():
    db_stat = db.get_database_status()
    collector_stat = collector.get_status()
    return {
        "status": "ONLINE",
        "service": "PYROGUARD-H Backend",
        "version": "3.0.0",
        "time": time.time(),
        "database": {
            "status": db_stat["status"],
            "integrity": db_stat["integrity"],
            "journal_mode": db_stat["journal_mode"],
            "total_readings": db_stat["counts"]["sensor_readings"],
            "active_alarms": db_stat["counts"]["alarm_events_active"],
            "pending_sync": db_stat["counts"]["sync_queue_pending"]
        },
        "cloud_sync": {
            "configured": sync_worker.provider.is_configured(),
            "status": sync_worker.last_status,
            "last_sync_utc": sync_worker.last_sync_utc,
            "pending_count": db_stat["counts"]["sync_queue_pending"]
        },
        "sensor": {
            "status": collector_stat["status"],
            "port": collector_stat["port"],
            "packets_received": collector_stat["packets_received"]
        }
    }

# ---------------------------------------------------------------------------
# Configuration Management
# ---------------------------------------------------------------------------
@app.get("/api/config", response_model=AppSettings)
def get_config():
    return load_settings()

@app.get("/api/settings", response_model=AppSettings)
def get_settings():
    return load_settings()

@app.post("/api/config", response_model=AppSettings)
def update_config(settings: AppSettings):
    saved = save_settings(settings)
    return saved

@app.post("/api/config/reset", response_model=AppSettings)
def reset_to_defaults():
    return reset_settings()

# ---------------------------------------------------------------------------
# Sensor Serial Collector Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/sensor/ports")
def get_serial_ports():
    ports = collector.list_available_ports()
    return {"ports": ports, "count": len(ports)}

@app.get("/api/sensor/status")
def get_sensor_status():
    return collector.get_status()

@app.post("/api/sensor/connect")
def connect_sensor(req: ConnectRequest):
    result = collector.connect(port=req.port, baud_rate=req.baud_rate)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to connect to COM port"))
    cfg = load_settings()
    cfg.sensor_com_port = req.port
    cfg.sensor_baud_rate = req.baud_rate
    save_settings(cfg)
    return result

@app.post("/api/sensor/disconnect")
def disconnect_sensor():
    result = collector.disconnect()
    return result

# ---------------------------------------------------------------------------
# Phase 2: Telemetry & Database API Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/sensor/readings/latest")
def get_latest_reading(device_id: Optional[str] = None):
    """Returns the most recent verified sensor reading from SQLite or collector."""
    latest = db.get_latest_sensor_reading(device_id=device_id)
    if not latest and collector.last_packet:
        latest = collector.last_packet
    return {
        "status": "SUCCESS",
        "latest": latest,
        "is_available": latest is not None
    }

@app.get("/api/sensor/readings/history")
def get_readings_history(
    limit: int = Query(default=50, ge=1, le=500, description="Max readings to return"),
    offset: int = Query(default=0, ge=0, description="Offset for pagination"),
    start_time: Optional[str] = Query(default=None, description="ISO-8601 UTC start filter"),
    end_time: Optional[str] = Query(default=None, description="ISO-8601 UTC end filter"),
    device_id: Optional[str] = Query(default=None, description="Filter by device ID")
):
    """
    Returns paginated sensor readings from the local SQLite database
    with date-range and device filtering.
    """
    readings, total_count = db.get_sensor_readings_history(
        limit=limit,
        offset=offset,
        start_time=start_time,
        end_time=end_time,
        device_id=device_id
    )
    return {
        "status": "SUCCESS",
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "has_more": (offset + len(readings)) < total_count,
        "readings": readings
    }

@app.post("/api/sensor/telemetry")
def submit_telemetry(payload: TelemetrySubmission):
    """
    Ingests telemetry from Web Serial or external collectors into the unified data layer.
    Validates, deduplicates, saves to SQLite, tracks alarm transitions, and broadcasts live.
    """
    data = payload.model_dump()
    normalized = telemetry_engine.process_reading(data, source=payload.source or "web_serial")
    if not normalized:
        return JSONResponse(
            status_code=202,
            content={"status": "IGNORED", "message": "Reading rejected as invalid or duplicate"}
        )
    return {
        "status": "ACCEPTED",
        "reading": normalized
    }

@app.get("/api/alarms")
def get_alarms(
    active_only: bool = Query(default=False, description="Filter active incidents only"),
    severity: Optional[str] = Query(default=None, description="Filter by severity: CRITICAL, WARNING, INFO"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0)
):
    """Returns paginated alarm events recorded by the hazard detection engine."""
    events, total_count = db.get_alarm_events(
        active_only=active_only,
        severity=severity,
        limit=limit,
        offset=offset
    )
    return {
        "status": "SUCCESS",
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "active_only": active_only,
        "alarms": events
    }

@app.post("/api/alarms/{event_id}/acknowledge")
def acknowledge_alarm(event_id: str, req: AlarmAcknowledgeRequest):
    """Marks an alarm incident as acknowledged by an operator with optional notes."""
    success = db.acknowledge_alarm_event(event_id=event_id, operator_notes=req.notes)
    if not success:
        raise HTTPException(status_code=404, detail=f"Alarm event {event_id} not found or update failed")
    return {
        "status": "ACKNOWLEDGED",
        "event_id": event_id,
        "notes": req.notes
    }

@app.get("/api/devices")
def get_devices():
    """Returns tracked devices, connection statuses, and last seen timestamps."""
    devices = db.get_all_devices()
    return {
        "status": "SUCCESS",
        "count": len(devices),
        "devices": devices
    }

@app.get("/api/database/status")
def get_database_status_route():
    """Returns local SQLite database health, WAL mode, record counts, and integrity."""
    return db.get_database_status()

# ---------------------------------------------------------------------------
# Real-Time WebSocket Telemetry Updates
# ---------------------------------------------------------------------------
@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    """
    Subscribes connected dashboard clients to real-time validated sensor updates.
    Sends latest state on connection, then streams every newly saved SQLite reading.
    """
    await manager.connect(websocket)
    try:
        # Send initial snapshot immediately upon connection
        latest = db.get_latest_sensor_reading() or collector.last_packet
        stat = collector.get_status()
        db_stat = db.get_database_status()
        ppe_stat = ppe_engine.get_status() if ppe_engine else None
        await websocket.send_json({
            "type": "init",
            "sensor_status": stat["status"],
            "latest_reading": latest,
            "database_status": db_stat["status"],
            "total_readings": db_stat["counts"]["sensor_readings"],
            "ppe_status": ppe_stat
        })

        while True:
            # Keep connection alive; accept ping or client heartbeats
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as e:
        logger.debug(f"WebSocket client error: {e}")
        await manager.disconnect(websocket)

# ---------------------------------------------------------------------------
# Phase 3: Cloud Backup & Synchronization Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/cloud/status")
async def get_cloud_status_route():
    """Returns real-time status of cloud backup configuration, internet connectivity, and queue."""
    return await sync_worker.get_status()

@app.post("/api/cloud/sync-now")
async def trigger_manual_cloud_sync():
    """Manually triggers an immediate cloud backup pass and returns real execution results."""
    result = await sync_worker.sync_once(force=True)
    return result

@app.get("/api/cloud/sync-history")
def get_cloud_sync_history_route(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: Optional[str] = Query(default=None, description="Filter: PENDING, SYNCED, FAILED")
):
    """Returns paginated cloud synchronization queue history."""
    records, total_count = db.get_sync_history(limit=limit, offset=offset, status_filter=status)
    return {
        "status": "SUCCESS",
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "records": records
    }

@app.post("/api/cloud/retry-failed")
def retry_failed_sync_records():
    """Resets all FAILED queue records to PENDING for immediate retry."""
    reset_count = db.reset_failed_sync_records()
    return {
        "status": "SUCCESS",
        "message": f"Reset {reset_count} failed records to PENDING for immediate retry.",
        "reset_count": reset_count
    }

# ---------------------------------------------------------------------------
# Camera IP, Web-Page, and Stream Management
# ---------------------------------------------------------------------------
@app.get("/api/camera/status")
async def get_camera_status():
    """
    Lightweight, non-blocking camera status probe.
    Does NOT initiate an MJPEG stream on port 81 to avoid single-client stream locks.
    Probes the ESP32-CAM HTTP interface on port 80 with a 1.5s timeout.
    """
    settings = load_settings()
    target_ip = (settings.camera_ip or "").strip()
    if not target_ip:
        return {
            "status": "Invalid Configuration",
            "is_online": False,
            "target_ip": "",
            "message": "Camera IP is not configured."
        }

    try:
        async with httpx.AsyncClient(timeout=1.5, verify=False) as client:
            resp = await client.get(f"http://{target_ip}/", headers={"User-Agent": "PYROGUARD-Monitor/1.0"})
            if resp.status_code == 200:
                return {
                    "status": "Online",
                    "is_online": True,
                    "target_ip": target_ip,
                    "status_code": resp.status_code
                }
            else:
                return {
                    "status": "Offline",
                    "is_online": False,
                    "target_ip": target_ip,
                    "status_code": resp.status_code,
                    "error": f"HTTP {resp.status_code}"
                }
    except (httpx.ConnectTimeout, httpx.ReadTimeout):
        return {
            "status": "Offline",
            "is_online": False,
            "target_ip": target_ip,
            "error": "Connection timed out"
        }
    except Exception as e:
        return {
            "status": "Offline",
            "is_online": False,
            "target_ip": target_ip,
            "error": str(e)
        }

@app.post("/api/camera/test")
async def test_camera_connection(req: CameraTestRequest):
    """
    Separates web interface health checks from actual MJPEG video stream verification.
    Validates HTTP status code, Content-Type, and stream chunk transmission.
    """
    settings = load_settings()
    target_ip = (req.camera_ip or settings.camera_ip).strip()
    target_stream_url = (req.stream_url or settings.camera_stream_url).strip()

    # Ensure stream URL points to port 81 /stream if user only entered IP
    if not target_stream_url or target_stream_url == f"http://{target_ip}" or target_stream_url == f"http://{target_ip}/":
        target_stream_url = f"http://{target_ip}:81/stream"

    diagnostics: Dict[str, Any] = {
        "target_ip": target_ip,
        "target_stream_url": target_stream_url,
        "is_online": False,
        "status": "Offline",
        "web_interface": {
            "is_online": False,
            "status_code": None,
            "content_type": None,
            "latency_ms": None,
            "details": ""
        },
        "video_stream": {
            "is_online": False,
            "status_code": None,
            "content_type": None,
            "is_mjpeg": False,
            "latency_ms": None,
            "details": ""
        },
        "snapshot_capture": {
            "is_online": False,
            "latency_ms": None,
            "details": ""
        },
        "suggestions": []
    }

    if not target_ip:
        diagnostics["status"] = "Invalid Configuration"
        diagnostics["suggestions"].append("Enter a valid IPv4 address (e.g. 10.131.84.41).")
        return diagnostics

    # Run the three probes concurrently with asyncio.gather to prevent sequential timeout stacking
    async def probe_web():
        web_start = time.time()
        try:
            async with httpx.AsyncClient(timeout=2.0, verify=False) as client:
                web_resp = await client.get(f"http://{target_ip}/", headers={"User-Agent": "PYROGUARD-Tester/1.0"})
                diagnostics["web_interface"]["latency_ms"] = int((time.time() - web_start) * 1000)
                diagnostics["web_interface"]["status_code"] = web_resp.status_code
                diagnostics["web_interface"]["content_type"] = web_resp.headers.get("content-type")
                if web_resp.status_code == 200:
                    diagnostics["web_interface"]["is_online"] = True
                    diagnostics["web_interface"]["details"] = f"Web UI reachable (HTTP {web_resp.status_code})"
        except Exception as e:
            diagnostics["web_interface"]["details"] = f"Web interface error: {e}"

    async def probe_snapshot():
        snap_start = time.time()
        try:
            async with httpx.AsyncClient(timeout=2.0, verify=False) as client:
                snap_resp = await client.get(f"http://{target_ip}/capture", headers={"User-Agent": "PYROGUARD-Tester/1.0"})
                diagnostics["snapshot_capture"]["latency_ms"] = int((time.time() - snap_start) * 1000)
                if snap_resp.status_code == 200 and "image" in str(snap_resp.headers.get("content-type")):
                    diagnostics["snapshot_capture"]["is_online"] = True
                    diagnostics["snapshot_capture"]["details"] = f"Snapshot capture active ({len(snap_resp.content)} bytes JPEG)"
        except Exception as e:
            diagnostics["snapshot_capture"]["details"] = f"Snapshot capture error: {e}"

    async def probe_stream():
        stream_start = time.time()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=2.0, read=2.5, write=2.0, pool=2.0)) as client:
                async with client.stream("GET", target_stream_url, headers={
                    "User-Agent": "PYROGUARD-Tester/1.0",
                    "Accept": "multipart/x-mixed-replace, image/jpeg, */*"
                }) as stream_resp:
                    elapsed_ms = int((time.time() - stream_start) * 1000)
                    diagnostics["video_stream"]["latency_ms"] = elapsed_ms
                    diagnostics["video_stream"]["status_code"] = stream_resp.status_code
                    content_type = stream_resp.headers.get("content-type", "")
                    diagnostics["video_stream"]["content_type"] = content_type

                    if "text/html" in content_type:
                        diagnostics["video_stream"]["is_mjpeg"] = False
                        diagnostics["video_stream"]["details"] = (
                            f"Target URL returned an HTML web page (text/html) instead of an MJPEG video stream. "
                            f"Stream must use port 81: http://{target_ip}:81/stream"
                        )
                        diagnostics["suggestions"].append("Change Stream Endpoint URL to http://" + target_ip + ":81/stream")
                    elif "multipart/x-mixed-replace" in content_type or "image" in content_type:
                        first_chunk = b""
                        async for chunk in stream_resp.aiter_bytes():
                            first_chunk = chunk
                            break

                        if len(first_chunk) > 0:
                            diagnostics["video_stream"]["is_online"] = True
                            diagnostics["video_stream"]["is_mjpeg"] = True
                            diagnostics["video_stream"]["details"] = f"Active MJPEG video stream verified ({len(first_chunk)} bytes initial chunk)"
                        else:
                            diagnostics["video_stream"]["details"] = "Connected to stream, but zero frame bytes received."
                    else:
                        diagnostics["video_stream"]["details"] = f"Unexpected Content-Type: {content_type}"

        except (httpx.ConnectError, httpx.ReadError) as err:
            err_str = str(err)
            if "10054" in err_str or "forcibly closed" in err_str or "reset" in err_str.lower():
                diagnostics["video_stream"]["details"] = (
                    "Stream port 81 connection reset. The ESP32-CAM hardware supports only ONE active MJPEG stream reader at a time. "
                    "Another browser tab (e.g. http://" + target_ip + "/) is currently viewing the stream."
                )
                diagnostics["suggestions"].append("Close the other browser tab viewing http://" + target_ip + "/ or stop the stream there.")
                diagnostics["suggestions"].append("Alternatively, switch Stream Mode to 'Snapshot Refresh' in Dashboard to view live feed concurrently.")
            else:
                diagnostics["video_stream"]["details"] = f"Stream connection failed: {err}"
        except httpx.ConnectTimeout:
            diagnostics["video_stream"]["details"] = "Connection to stream endpoint timed out after 2.0s."
            diagnostics["suggestions"].append("Verify port 81 is open and accessible on " + target_ip)
        except Exception as e:
            diagnostics["video_stream"]["details"] = f"Stream diagnostic exception: {e}"

    await asyncio.gather(probe_web(), probe_snapshot(), probe_stream())

    # Overall Verdict
    if diagnostics["video_stream"]["is_online"]:
        diagnostics["is_online"] = True
        diagnostics["status"] = "Online"
    elif diagnostics["web_interface"]["is_online"] and ("10054" in diagnostics["video_stream"]["details"] or "busy" in diagnostics["video_stream"]["details"]):
        diagnostics["is_online"] = False
        diagnostics["status"] = "Stream Busy (1-Client Limit)"
    elif diagnostics["web_interface"]["is_online"] and not diagnostics["video_stream"]["is_mjpeg"]:
        diagnostics["is_online"] = False
        diagnostics["status"] = "Invalid Stream Endpoint"
    elif diagnostics["web_interface"]["is_online"]:
        diagnostics["is_online"] = False
        diagnostics["status"] = "Web Online / Stream Offline"
    else:
        diagnostics["is_online"] = False
        diagnostics["status"] = "Offline"
        diagnostics["suggestions"].append("Ensure ESP32-CAM is powered and on the same local Wi-Fi subnet.")

    return diagnostics

# ---------------------------------------------------------------------------
# Camera Multiplexing & Resilient Streaming Hub
# ---------------------------------------------------------------------------

class CameraStreamHub:
    """
    Centralized camera streaming hub.
    Maintains a single background worker to capture fresh frames from the ESP32-CAM,
    and multiplexes them to active HTTP subscribers.
    - Eliminates Port 81 single-client hardware locking.
    - Seamlessly maintains streaming across tab switches via a 12s grace period.
    - Deduplicates client connections and forcibly terminates superseded dangling sockets
      so browser HTTP/1.1 6-connection limits are never exhausted!
    - Distributes frames to unlimited concurrent clients.
    - Transparently falls back to high-speed /capture polling if Port 81 is busy or fails.
    - Caches latest frame for instant (0ms) delivery to new subscribers upon tab mount.
    """
    def __init__(self):
        self._queues: List[asyncio.Queue] = []
        self._subscribers: Dict[str, Tuple[asyncio.Queue, asyncio.Event]] = {}
        self._lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task] = None
        self._latest_frame: Optional[bytes] = None

    async def register_subscriber(self, client_id: str) -> Tuple[asyncio.Queue, asyncio.Event]:
        q: asyncio.Queue = asyncio.Queue(maxsize=4)
        stop_event = asyncio.Event()

        async with self._lock:
            # If a connection already exists for this client_id, forcibly evict it
            # so the browser's old dangling TCP socket is immediately closed!
            if client_id in self._subscribers:
                old_q, old_stop = self._subscribers[client_id]
                old_stop.set()
                if old_q in self._queues:
                    self._queues.remove(old_q)

            self._subscribers[client_id] = (q, stop_event)
            self._queues.append(q)

            if self._latest_frame:
                try:
                    q.put_nowait(self._latest_frame)
                except Exception:
                    pass

            if not self._worker_task or self._worker_task.done():
                self._worker_task = asyncio.create_task(self._capture_loop())

        return q, stop_event

    def ensure_capture_loop(self):
        if not self._worker_task or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._capture_loop())

    async def unregister_subscriber(self, client_id: str, q: asyncio.Queue):
        async with self._lock:
            if client_id in self._subscribers:
                curr_q, _ = self._subscribers[client_id]
                if curr_q is q:
                    del self._subscribers[client_id]
            if q in self._queues:
                self._queues.remove(q)

    async def _broadcast_frame(self, frame_bytes: bytes):
        self._latest_frame = frame_bytes
        for q in list(self._queues):
            if q.full():
                try:
                    q.get_nowait()
                except Exception:
                    pass
            try:
                q.put_nowait(frame_bytes)
            except Exception:
                pass

    async def _capture_loop(self):
        """Worker loop that fetches frames from the camera while there are active subscribers."""
        logger.info("CameraStreamHub capture loop active.")
        no_subs_since: Optional[float] = None

        while True:
            async with self._lock:
                has_subs = len(self._queues) > 0 or (ppe_engine is not None and getattr(ppe_engine, "is_running", False))

            if not has_subs:
                if no_subs_since is None:
                    no_subs_since = time.time()
                elif time.time() - no_subs_since > 12.0:
                    logger.info("No active camera subscribers or PPE engine for 12s. Pausing capture loop.")
                    break
                await asyncio.sleep(0.5)
                continue
            else:
                no_subs_since = None

            settings = load_settings()
            target_ip = (settings.camera_ip or "").strip()
            if not target_ip:
                await asyncio.sleep(1.0)
                continue

            stream_url = settings.camera_stream_url
            if not stream_url or stream_url == f"http://{target_ip}" or stream_url == f"http://{target_ip}/":
                stream_url = f"http://{target_ip}:81/stream"

            # 0. If no cached frame yet, immediately fetch a fast snapshot (< 300ms) for instant display
            if self._latest_frame is None:
                try:
                    async with httpx.AsyncClient(timeout=1.0) as quick_client:
                        snap = await quick_client.get(f"http://{target_ip}/capture", headers={"User-Agent": "PYROGUARD-Hub/1.0"})
                        if snap.status_code == 200 and snap.content:
                            await self._broadcast_frame(snap.content)
                except Exception:
                    pass

            # 1. Attempt upstream MJPEG video stream (Port 81)
            stream_succeeded = False
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(connect=1.2, read=3.5, write=1.5, pool=2.0)) as client:
                    async with client.stream("GET", stream_url, headers={
                        "User-Agent": "PYROGUARD-Hub/1.0",
                        "Accept": "multipart/x-mixed-replace, image/jpeg, */*"
                    }) as resp:
                        if resp.status_code == 200 and "multipart" in resp.headers.get("content-type", ""):
                            stream_succeeded = True
                            buffer = b""
                            async for chunk in resp.aiter_bytes():
                                async with self._lock:
                                    has_subs = len(self._queues) > 0
                                if not has_subs:
                                    if no_subs_since is None:
                                        no_subs_since = time.time()
                                    elif time.time() - no_subs_since > 12.0:
                                        break
                                else:
                                    no_subs_since = None

                                buffer += chunk
                                while True:
                                    soi = buffer.find(b"\xff\xd8")
                                    if soi == -1:
                                        buffer = b""
                                        break
                                    eoi = buffer.find(b"\xff\xd9", soi + 2)
                                    if eoi == -1:
                                        if len(buffer) > 150000:
                                            buffer = buffer[soi:]
                                        break
                                    frame = buffer[soi:eoi+2]
                                    buffer = buffer[eoi+2:]
                                    await self._broadcast_frame(frame)
            except Exception as e:
                logger.debug(f"Port 81 stream not connected ({e}); using Port 80 /capture fallback.")

            # 2. If Port 81 is busy (1-client limit) or times out, smoothly poll /capture (Port 80)
            if not stream_succeeded:
                try:
                    async with httpx.AsyncClient(timeout=1.5) as client:
                        poll_count = 0
                        while poll_count < 35: # Retry Port 81 after ~3-4 seconds of fallback
                            async with self._lock:
                                has_subs = len(self._queues) > 0
                            if not has_subs:
                                if no_subs_since is None:
                                    no_subs_since = time.time()
                                elif time.time() - no_subs_since > 12.0:
                                    break
                            else:
                                no_subs_since = None

                            t_start = time.time()
                            try:
                                resp = await client.get(f"http://{target_ip}/capture", headers={"User-Agent": "PYROGUARD-Hub/1.0"})
                                if resp.status_code == 200 and resp.content:
                                    await self._broadcast_frame(resp.content)
                            except Exception:
                                pass

                            poll_count += 1
                            elapsed = time.time() - t_start
                            sleep_t = max(0.03, 0.08 - elapsed)
                            await asyncio.sleep(sleep_t)
                except Exception as e:
                    logger.debug(f"Snapshot fallback error: {e}")
                    await asyncio.sleep(0.3)

camera_hub = CameraStreamHub()
ppe_engine = PPEInferenceEngine(camera_hub=camera_hub)

def broadcast_ppe_event_sync(payload: Dict[str, Any]):
    """Callback invoked by PPEInferenceEngine when an incident occurs or updates."""
    global main_loop
    if main_loop and main_loop.is_running():
        try:
            asyncio.run_coroutine_threadsafe(
                manager.broadcast(payload),
                main_loop
            )
        except Exception as e:
            logger.debug(f"Could not dispatch ppe event broadcast: {e}")

ppe_engine.register_incident_listener(broadcast_ppe_event_sync)

@app.get("/api/camera/stream")
async def proxy_camera_stream(
    request: Request,
    client: Optional[str] = Query(default=None),
    t: Optional[str] = Query(default=None)
):
    """
    Multiplexed, zero-locking MJPEG stream endpoint.
    Serves concurrent browser tabs and components with automatic client eviction
    to prevent Chrome HTTP/1.1 socket pool exhaustion across tab navigation.
    """
    client_ip = request.client.host if request.client else "127.0.0.1"
    # Scope by client query param (e.g. 'overview', 'camera_tab') or client IP
    client_id = f"{client_ip}_{client or 'default'}"
    queue, stop_event = await camera_hub.register_subscriber(client_id)
    boundary = "123456789000000000000987654321"

    async def stream_generator():
        try:
            while not stop_event.is_set():
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=3.0)
                    header = (
                        f"--{boundary}\r\n"
                        f"Content-Type: image/jpeg\r\n"
                        f"Content-Length: {len(frame)}\r\n\r\n"
                    ).encode("utf-8")
                    yield header + frame + b"\r\n"
                except asyncio.TimeoutError:
                    if await request.is_disconnected() or stop_event.is_set():
                        break
                    # Keep-alive frame using cached frame if stream is momentarily quiet
                    if camera_hub._latest_frame:
                        header = (
                            f"--{boundary}\r\n"
                            f"Content-Type: image/jpeg\r\n"
                            f"Content-Length: {len(camera_hub._latest_frame)}\r\n\r\n"
                        ).encode("utf-8")
                        yield header + camera_hub._latest_frame + b"\r\n"
        finally:
            await camera_hub.unregister_subscriber(client_id, queue)

    return StreamingResponse(
        stream_generator(),
        media_type=f"multipart/x-mixed-replace; boundary={boundary}",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
            "Connection": "close"
        }
    )

@app.get("/api/camera/capture")
async def proxy_camera_snapshot():
    """
    Proxies a single fresh JPEG frame from the camera's /capture endpoint.
    Provides a low-resource live preview that avoids port 81 locking conflicts.
    """
    settings = load_settings()
    capture_url = f"http://{settings.camera_ip}/capture"

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(capture_url, headers={"User-Agent": "PYROGUARD-Snapshot/1.0"})
            if resp.status_code == 200:
                return RawResponse(
                    content=resp.content,
                    media_type="image/jpeg",
                    headers={
                        "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
                        "Pragma": "no-cache",
                        "Expires": "0",
                        "Access-Control-Allow-Origin": "*"
                    }
                )
            else:
                return JSONResponse(status_code=resp.status_code, content={"error": f"Camera returned HTTP {resp.status_code}"})
    except Exception as e:
        return JSONResponse(status_code=503, content={"error": str(e)})

# ---------------------------------------------------------------------------
# Phase 5A: AI-Powered PPE Monitoring Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/ppe/status")
def get_ppe_status():
    """Returns real-time status of the local PPE AI inference engine."""
    if not ppe_engine:
        return {
            "ai_status": "DISABLED",
            "supported_categories": ["helmet", "goggles", "gloves", "mask", "shoes"],
            "unsupported_categories": ["protective_clothing_antistatic_overalls"],
            "workers": []
        }
    return ppe_engine.get_status()

@app.get("/api/ppe/workers")
def get_ppe_workers():
    """Returns currently tracked workers and their real-time PPE compliance states."""
    if not ppe_engine:
        return {"workers": [], "count": 0}
    status = ppe_engine.get_status()
    workers = status.get("workers", [])
    return {"workers": workers, "count": len(workers)}

@app.get("/api/ppe/incidents")
def get_ppe_incidents(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: Optional[str] = Query(default=None, description="Filter by status: OPEN, RESOLVED, ACKNOWLEDGED")
):
    """Returns paginated PPE violation incident records from SQLite."""
    incidents, total_count = db.get_ppe_incidents(limit=limit, offset=offset, status_filter=status)
    return {
        "status": "SUCCESS",
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "incidents": incidents
    }

@app.get("/api/ppe/incidents/{incident_id}")
def get_ppe_incident_detail(incident_id: str):
    """Retrieves a single PPE incident by ID."""
    incident = db.get_ppe_incident_by_id(incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="PPE Incident not found")
    return {"status": "SUCCESS", "incident": incident}

@app.post("/api/ppe/incidents/{incident_id}/acknowledge")
def acknowledge_ppe_incident_route(incident_id: str, req: PPEIncidentAcknowledgeRequest):
    """Allows an operator to acknowledge an active PPE incident with optional notes."""
    updated = db.acknowledge_ppe_incident(incident_id, notes=req.notes)
    if not updated:
        raise HTTPException(status_code=404, detail="Incident not found or could not be acknowledged")
    return {"status": "SUCCESS", "incident": updated}

@app.get("/api/ppe/evidence/{filename}")
def get_ppe_evidence_image(filename: str):
    """Serves high-resolution annotated evidence snapshots captured during 60-second PPE violations."""
    safe_name = os.path.basename(filename)
    evidence_dir = Path(__file__).resolve().parent / "evidence"
    file_path = evidence_dir / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Evidence image not found")
    return FileResponse(
        str(file_path),
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*"
        }
    )

@app.post("/api/ppe/config")
def update_ppe_config(req: PPEConfigRequest):
    """Dynamically updates inference FPS, confidence thresholds, and required categories."""
    if not ppe_engine:
        raise HTTPException(status_code=503, detail="PPE Engine not available")
    updated = ppe_engine.update_config(
        target_fps=req.target_fps,
        conf_threshold=req.conf_threshold,
        violation_threshold_sec=req.violation_threshold_sec,
        required_categories=req.required_categories
    )
    return {"status": "SUCCESS", "config": updated}

@app.get("/api/ppe/stream")
async def ppe_annotated_stream(request: Request):
    """
    Live AI-annotated MJPEG stream displaying tracked worker boxes,
    detected PPE items, confidence scores, and 10-second countdown bars.
    """
    boundary = "frame_boundary_ppe_hud_0987654321"
    client_ip = request.client.host if request.client else "127.0.0.1"
    client_id = f"{client_ip}_ppe_hud"
    queue, stop_event = await camera_hub.register_subscriber(client_id)

    async def stream_generator():
        try:
            while not stop_event.is_set():
                if await request.is_disconnected():
                    break
                frame = getattr(ppe_engine, "_latest_annotated_frame", None) if ppe_engine else None
                # If no annotated frame is ready yet, fall back gracefully to the camera hub frame
                if not frame and camera_hub:
                    frame = camera_hub._latest_frame

                if frame:
                    header = (
                        f"--{boundary}\r\n"
                        f"Content-Type: image/jpeg\r\n"
                        f"Content-Length: {len(frame)}\r\n\r\n"
                    ).encode("utf-8")
                    yield header + frame + b"\r\n"
                    target_fps = getattr(ppe_engine, "target_fps", 5.0) or 5.0
                    await asyncio.sleep(max(0.04, 1.0 / target_fps))
                else:
                    await asyncio.sleep(0.1)
        except Exception:
            pass
        finally:
            await camera_hub.unregister_subscriber(client_id, queue)

    return StreamingResponse(
        stream_generator(),
        media_type=f"multipart/x-mixed-replace; boundary={boundary}",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
            "Connection": "close"
        }
    )

# ---------------------------------------------------------------------------
# Network Diagnostics
# ---------------------------------------------------------------------------
@app.get("/api/network/diagnostics")
def get_network_diagnostics():
    settings = load_settings()
    local_ips = []
    hostname = socket.gethostname()
    try:
        addr_infos = socket.getaddrinfo(hostname, None, socket.AF_INET)
        for item in addr_infos:
            ip = item[4][0]
            if ip not in local_ips and not ip.startswith("127."):
                local_ips.append(ip)
    except Exception:
        pass

    camera_ip = settings.camera_ip
    camera_subnet = ".".join(camera_ip.split(".")[:3]) if "." in camera_ip else ""
    matching_subnets = [ip for ip in local_ips if ".".join(ip.split(".")[:3]) == camera_subnet]

    return {
        "hostname": hostname,
        "host_ips": local_ips,
        "camera_target_ip": camera_ip,
        "is_on_same_subnet": len(matching_subnets) > 0,
        "matching_host_ip": matching_subnets[0] if matching_subnets else None,
        "cloud_independent": True,
        "note": "Manual IP entry in settings sets the destination for the dashboard; it does not change the IP inside the ESP32-CAM hardware."
    }

# ---------------------------------------------------------------------------
# Production Frontend SPA Static Mount
# ---------------------------------------------------------------------------
from fastapi.staticfiles import StaticFiles

BACKEND_DIR = Path(__file__).resolve().parent
DIST_DIR = BACKEND_DIR / "dist"
if not DIST_DIR.exists():
    DIST_DIR = BACKEND_DIR.parent / "frontend" / "dist"

if DIST_DIR.exists():
    logger.info(f"Mounting production frontend from {DIST_DIR}")
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
