# PYROGUARD-H | Industrial Safety Command Center

PyroGuard-H is a local-first industrial environmental hazard telemetry and real-time computer vision safety compliance platform. The system integrates dual ESP32 microcontrollers (environmental telemetry and optical camera surveillance), local SQLite persistence, Supabase cloud synchronization, and local YOLOv8 neural network inference for PPE compliance monitoring.

> **Safety Notice:** PyroGuard-H is an engineering prototype and student capstone demonstration system. It is not a certified life-safety or industrial fire protection appliance.

---

## Architecture Overview

```
                      +-----------------------------+
                      |   ESP32 DevKit V1 (Sensors) |
                      |   - DHT22 (Temp / Humidity) |
                      |   - Optical Flame Sensor    |
                      |   - Autonomous HW Buzzer    |
                      +--------------+--------------+
                                     | USB Serial (115200 baud)
                                     v
+-----------------------+     +-------------------------------+     +-----------------------+
|  ESP32-CAM (OV2640)   | --> |     FastAPI Python Backend    | --> |    Local SQLite DB    |
|  - MJPEG Port 81      |     |     - Telemetry Aggregator    |     |    (WAL Mode Engine)  |
|  - Web UI Port 80     |     |     - YOLOv8 Person & Helmet  |     +-----------+-----------+
+-----------------------+     |     - MJPEG Stream Proxy      |                 |
                              +---------------+---------------+                 v
                                              |                    +------------------------+
                                              v                    | Supabase Cloud Backup  |
                              +-------------------------------+    | (30s Idempotent Sync)  |
                              | React Safety Command Center   |    +------------------------+
                              | - Real-time Cockpit / HUD     |
                              | - Configurable PPE Threshold  |
                              +-------------------------------+
```

---

## Prerequisites

1. **Host Operating System:** Windows 10/11 or Linux with USB Serial driver support (CP210x / CH340).
2. **Python Environment:** Python 3.10 or 3.11 with virtual environment (`backend/venv`).
3. **Node.js Environment:** Node.js 18+ and npm (`frontend/node_modules`).
4. **Hardware Devices:**
   - ESP32 DevKit V1 connected via USB Serial (Default: `COM4`, 115200 baud).
   - AI-Thinker ESP32-CAM connected via Wi-Fi (Default: `10.131.84.41`).

---

## Quick & Easy 1-Click Startup (Recommended)

Simply **double-click** the launcher file in the project folder:
- **`start_pyroguard.bat`**: Launches the backend, starts the frontend, and automatically opens your browser to `http://localhost:3000/`.
- **`stop_pyroguard.bat`**: Stops all running background services cleanly.

---

## Manual Startup Instructions (Alternative)

### 1. Start the Backend API & Computer Vision Server
From the repository root:
```powershell
cd A:\pyro_guard\backend
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```
- API Documentation (Swagger UI): `http://127.0.0.1:8000/docs`
- Health Endpoint: `http://127.0.0.1:8000/api/health`

### 2. Start the Frontend Command Center
In a separate terminal:
```powershell
cd A:\pyro_guard\frontend
npm run dev -- --host 0.0.0.0 --port 3000
```
- Web Application Interface: `http://localhost:3000/`

---

## Hardware & Network Configuration

### ESP32 Sensor Node (Environmental Telemetry)
- **Port:** Configurable via **Device Connections** tab or `backend/settings.json` (e.g. `COM4`).
- **Baud Rate:** `115200` (strictly matches ESP32 firmware).
- **Sensors:** DHT22 Temperature & Humidity (GPIO 4), Flame Sensor Digital OUT (GPIO 27 / 14).
- **Physical Buzzer:** Controlled directly by ESP32 firmware on GPIO 26 / 12. Operates 100% autonomously without internet or laptop dependency.

### ESP32-CAM (Visual Surveillance)
- **Default IP:** `10.131.84.41`
- **Video Stream:** `http://10.131.84.41:81/stream` (proxied via `/api/camera/stream` to prevent CORS / private network access blocks).
- **Snapshot Endpoint:** `http://10.131.84.41/capture`
- **Hardware Constraint:** The ESP32-CAM microcontroller hardware supports only **ONE** active MJPEG client on port 81 at a time. If port 81 is locked, the command center provides an automatic fallback to Snapshot Refresh mode.

---

## Computer Vision PPE Monitoring Pipeline

- **Inference Engine:** Dual Ultralytics YOLOv8 architecture running locally on host CPU:
  - `yolov8n.pt`: General person spatial tracking with ByteTrack ID persistence.
  - `ppe_yolov8n.pt` & `helmet_iam_tsr.pt`: Specialized hardhat, safety helmet, and motorcycle helmet multi-model classification.
- **Supported Detection Classes:**
  - `Helmet / Hardhat`: Supported and validated (high-confidence detection for industrial hardhats and motorcycle helmets).
  - `Safety Goggles`, `Protective Gloves`, `Face Mask / Respirator`, `Protective Footwear`: Supported via standard pretrained PPE definitions.
- **Violation Threshold:** Configurable from the web interface (`5s`, `10s`, `30s`, `60s`). Default: `10.0 seconds`.
- **Evidence Snapshots:** When an unequipped worker is detected continuously beyond the configured threshold, an evidence frame with overlaid bounding boxes and violation metadata is automatically saved to `backend/evidence/` and logged to SQLite.

---

## Local-First Storage & Supabase Cloud Backup

- **Local Storage:** SQLite database at `backend/pyroguard.db` configured in Write-Ahead Logging (`WAL`) mode with foreign key integrity.
- **Cloud Backup:** Supabase PostgREST synchronization worker runs every 30 seconds. Idempotent upserts prevent duplicate records during connection retries.
- **Offline Durability:** If internet connectivity drops, telemetry continues streaming and logging locally without data loss. Queued records automatically upload upon connection restoration.

---

## Verified Clean Handover State

All historical demonstration telemetry, test alarms, and sample evidence snapshots have been wiped in accordance with Step 9 of the release protocol. The system boots into a clean operational state:
- `sensor_readings`: 0 records
- `alarm_events`: 0 records
- `ppe_incidents`: 0 records
- `sync_queue`: 0 records
- `evidence/`: 0 files
- `devices`: 1 record (`PYRO-ESP32` device profile preserved)
