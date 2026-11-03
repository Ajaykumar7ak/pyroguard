# PYROGUARD-H | Phase 1: Project Audit & Connection Settings

## 1. Executive Summary & Project Status

PYROGUARD-H is an industrial worker-safety and environmental hazard monitoring platform designed for real-time telemetry acquisition, fire detection, and low-latency video streaming.

- **Workspace**: `A:\pyro_guard`
- **Host Machine**: `ajay_pc` (Windows 11 / x64, Node.js v24.16.0, Python 3.14.6)
- **Phase Implemented**: **Phase 1: Connection Settings and Project Audit**
- **Hardware Integration Status**: Verified against host hardware; COM ports `COM4` (CP210x UART Bridge) and `COM8` (FTDI Serial Port) automatically detected.

---

## 2. Architecture & Connection Identification

Prior to implementation, the connection pathways and architectural options were audited. PYROGUARD-H provides a unified, highly resilient dual-mode architecture:

```
+-----------------------------------------------------------------------------------+
|                                 BROWSER CLIENT                                    |
|   React + Vite Dashboard (Port 3000)                                             |
|   - Real-time Connection State (Connected, Connecting, Disconnected, Error)       |
|   - Sensor Telemetry Inspector (Temp °C, RH %, Flame Status, Buzzer State)        |
|   - Camera Stream Preview (Direct Stream or Proxied Bridge)                       |
|   - Network Portability & Diagnostic Console                                      |
+-------------------------------------+---------------------------------------------+
                                      |
              +-----------------------+-----------------------+
              | (Option A: Direct)                            | (Option B: Recommended)
              v                                               v
    [ Web Serial API ]                             [ Local Python Gateway ]
   Direct Browser-to-USB                              FastAPI (Port 8000)
   (Chrome / Edge native)                                     |
              |                                               +---> SQLite Local DB (Phase 2)
              |                                               +---> Offline Queue & Retry
              |                                               +---> Exclusive Serial Reader Lock
              |                                               +---> MJPEG Stream Proxy
              |                                                         |
              +-----------------------+---------------------------------+
                                      |
                                      v
                      +-------------------------------+
                      |   HARDWARE DEPLOYMENT NODES   |
                      +---------------+---------------+
                                      |
       +------------------------------+------------------------------+
       |                                                             |
       v (USB Serial @ 115200 Baud)                                  v (Wi-Fi 802.11 b/g/n)
[ ESP32 Sensor Node ]                                     [ AI-Thinker ESP32-CAM ]
- DHT22 Temp & Humidity (GPIO 4)                          - OV2640 2MP Camera Sensor
- IR Flame Sensor (GPIO 14 DO / GPIO 34 AO)               - MJPEG Stream Server (:81/stream)
- Warning Buzzer (GPIO 12)                                - Flash LED (GPIO 4)
- Telemetry: NDJSON @ 1 Hz                                - Stream Rate: 15-25 FPS
```

### Sensor Connection Architecture Comparison

| Feature | Python Serial Collector (Recommended) | Web Serial API (Browser Direct) |
| :--- | :--- | :--- |
| **Execution Environment** | Windows background thread (`backend/collector.py`) | Browser renderer process (`navigator.serial`) |
| **Port Access** | Exclusive OS COM port handle (`threading.Lock`) | Browser security prompt & port lock |
| **Background Buffering** | Continues logging if browser tab is closed/refreshed | Stops streaming if tab is closed |
| **Multi-Client Access** | Any device on local Wi-Fi can view the telemetry | Limited to the local PC running Chrome/Edge |
| **Default Baud Rate** | **115200 Baud** (8-N-1) | **115200 Baud** (8-N-1) |
| **Hardware Auto-Detection**| Auto-scans and identifies CP210x, CH340, FTDI | Requires manual USB device selection |

---

## 3. Data & Communication Contracts

### A. ESP32 Sensor Node Serial Protocol

- **Baud Rate**: `115200`
- **Data Format**: Newline-delimited JSON (NDJSON)
- **Transmission Frequency**: `1.0 Hz` (1000 ms interval)
- **Sample Payload**:
```json
{
  "device_id": "PYRO-ESP32-01",
  "packet_id": 142,
  "uptime_s": 142,
  "temp_c": 28.40,
  "humidity_pct": 55.20,
  "flame_detected": false,
  "flame_raw": 3210,
  "buzzer_active": false,
  "sensor_status": "NORMAL"
}
```

### B. ESP32-CAM Video Stream Contract

- **Sensor**: OV2640 2 Megapixel
- **Resolution**: VGA (`640x480`) or SVGA (`800x600`)
- **Encoding**: MJPEG (Motion JPEG)
- **Endpoints**:
  - `http://<ESP32_CAM_IP>:81/stream` (Standard AI-Thinker CameraWebServer stream route)
  - `http://<ESP32_CAM_IP>/stream` (Port 80 secondary stream route)
  - `http://<ESP32_CAM_IP>/capture` (Single JPEG snapshot route)
  - `/api/camera/stream` (FastAPI stream proxy bridge resolving browser CORS and Private Network Access restrictions)

---

## 4. Master Feature Plan Status (Phase 1 Baseline)

| Module | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| **1. Sensor Connection** | COM Port & Baud Selector | **COMPLETED** | Tested with autodetected `COM4` / `COM8` |
| | 115200 Baud Default | **COMPLETED** | Matches ESP32 sensor firmware |
| | Connection State Display | **COMPLETED** | Connected, Connecting, Disconnected, Error |
| | Incoming Data Health | **COMPLETED** | Packet counter, byte volume, >3s stale warning |
| | Web Serial Browser Mode | **COMPLETED** | Native `navigator.serial` integration |
| | Python Collector Mode | **COMPLETED** | Background thread with exclusive port lock |
| **2. Camera IP Settings** | Manual Camera IPv4 Field | **COMPLETED** | Validates IPv4 pattern (e.g. `192.168.1.50`) |
| | Custom Stream URL Field | **COMPLETED** | Supports custom ports/routes (e.g. `:81/stream`) |
| | Save / Test / Reset Actions | **COMPLETED** | Real socket and HTTP probe diagnostics |
| | Stream Proxy Bridge | **COMPLETED** | FastAPI `/api/camera/stream` handles CORS/PNA |
| | Stream Fallback Screen | **COMPLETED** | Displays troubleshooting tips when stream drops |
| | Setting Persistence | **COMPLETED** | Persists to `settings.json` and `localStorage` |
| **3. Network Portability** | Dynamic IP Configuration | **COMPLETED** | No frontend source code edits required |
| | Subnet Match Diagnostic | **COMPLETED** | Verifies PC and camera are on same subnet |
| | Cloud Independence | **COMPLETED** | 100% functional offline without internet |
| **4. Planned Future Phases** | Local SQLite Database | *Planned (Phase 2)* | Local history, alarm events, offline sync |
| | AI Fire/Smoke Computer Vision | *Planned (Phase 3)* | Edge/browser AI inference on stream |
| | Historical Analytics & Export | *Planned (Phase 4)* | Charts, daily logs, CSV export |
