# PYROGUARD-H | Hardware Setup & Verification Guide

This guide describes how to flash, wire, and verify physical hardware nodes for the PYROGUARD-H platform.

---

## 1. ESP32 Sensor Node Setup

### A. Hardware Bill of Materials
1. **ESP32 DevKit V1** (30-pin or 38-pin version)
2. **DHT22 (AM2302)** Digital Temperature & Humidity Sensor
3. **IR Flame Sensor Module** (LM393 comparator based with Digital & Analog outputs)
4. **Active 3.3V / 5V Buzzer**
5. **Micro-USB Cable** connected to Windows PC

### B. Pinout & Wiring Table

| Component | Pin / Signal | ESP32 GPIO | Description / Notes |
| :--- | :--- | :--- | :--- |
| **DHT22** | VCC | `3V3` or `VIN` | Power supply (3.3V - 5V) |
| | GND | `GND` | Ground reference |
| | DATA | **`GPIO 4`** | Single-bus bidirectional data with 10k pullup |
| **Flame Sensor** | VCC | `VIN` or `3V3` | Power supply |
| | GND | `GND` | Ground reference |
| | DO (Digital Out) | **`GPIO 14`** | Digital threshold (Pulls LOW when flame detected) |
| | AO (Analog Out) | **`GPIO 34`** | ADC channel reading raw IR flicker intensity |
| **Active Buzzer** | (+) Anode | **`GPIO 12`** | Active HIGH trigger |
| | (-) Cathode | `GND` | Ground reference |
| **Status LED** | Onboard | **`GPIO 2`** | Blinks on boot & active hazard |

### C. Flashing Instructions (Arduino IDE or PlatformIO)
1. Open [`firmware/esp32_sensor/esp32_sensor.ino`](file:///a:/pyro_guard/firmware/esp32_sensor/esp32_sensor.ino).
2. Install required library: `DHT sensor library` by Adafruit.
3. Select Board: `DOIT ESP32 DEVKIT V1` (or your specific ESP32 variant).
4. Select the matching COM port (e.g., `COM4` as detected on this workstation).
5. Click **Upload**.
6. Once flashed, open Serial Monitor at **115200 baud** to confirm:
   ```json
   {"event":"system_ready","device_id":"PYRO-ESP32-01","firmware":"1.0.0-phase1","baud":115200}
   {"device_id":"PYRO-ESP32-01","packet_id":1,"uptime_s":1,"temp_c":27.50,"humidity_pct":58.00,"flame_detected":false,"flame_raw":3450,"buzzer_active":false,"sensor_status":"NORMAL"}
   ```

---

## 2. AI-Thinker ESP32-CAM Setup

### A. Hardware Bill of Materials
1. **AI-Thinker ESP32-CAM** with OV2640 camera module
2. **FTDI USB-to-TTL Adapter** (set jumper to **5V**)
3. External **5V 2A** power supply (essential for stable Wi-Fi streaming)

### B. FTDI Programmer Wiring

| FTDI Adapter | ESP32-CAM Pin | Purpose |
| :--- | :--- | :--- |
| **5V (VCC)** | `5V` | Stable power input (avoids brownout resets) |
| **GND** | `GND` | Common ground |
| **TXD** | `U0R` (GPIO 3) | ESP32 Serial Receive |
| **RXD** | `U0T` (GPIO 1) | ESP32 Serial Transmit |
| **GND** | **`GPIO 0`** | **Bridge to GND during flash; disconnect for run mode** |

### C. Flashing Instructions
1. Open [`firmware/esp32_cam/esp32_cam.ino`](file:///a:/pyro_guard/firmware/esp32_cam/esp32_cam.ino).
2. In the code, set your Wi-Fi credentials:
   ```cpp
   const char* ssid = "YOUR_WIFI_SSID";
   const char* password = "YOUR_WIFI_PASSWORD";
   ```
3. Select Board: `AI Thinker ESP32-CAM`.
4. Select Partition Scheme: `Huge APP (3MB No OTA/1MB SPIFFS)`.
5. Connect **GPIO 0 to GND**, plug in FTDI adapter, and press the onboard **RST** button.
6. Click **Upload**.
7. Once upload is complete:
   - Disconnect **GPIO 0 from GND**.
   - Press the **RST** button once.
8. Open Serial Monitor at **115200 baud** to note the assigned local IP address:
   ```text
   [WIFI] Connected successfully!
   [WIFI] Assigned Local IP Address: 192.168.1.50
   [STREAM] Main Stream URL: http://192.168.1.50:81/stream
   ```

---

## 3. Dashboard Verification Steps

### Step 1: Launch Local Services
1. Backend Gateway (FastAPI):
   ```powershell
   cd a:\pyro_guard\backend
   .\venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000
   ```
2. Frontend Dashboard (React + Vite):
   ```powershell
   cd a:\pyro_guard\frontend
   npm run dev -- --host 0.0.0.0 --port 3000
   ```
3. Open browser: `http://localhost:3000`

### Step 2: Verify Sensor Connection
1. In the **Device Connections** tab:
   - Select **Python Collector**.
   - Choose `COM4` (or your device COM port) from the dropdown.
   - Confirm baud rate is set to `115200`.
   - Click **Connect Device**.
   - Verify status transitions to `CONNECTED` (green pulse).
   - Check that incoming packet counter increments at 1 Hz and telemetry readings update in real time.

### Step 3: Verify Camera Stream
1. Switch to the **Camera Feeds** tab.
2. In the **ESP32-CAM Local IPv4 Address** field, enter the IP reported by the ESP32-CAM Serial Monitor (e.g. `192.168.1.50`).
3. Stream Endpoint will automatically format as `http://192.168.1.50:81/stream`.
4. Ensure Stream Bridge Mode is set to **Backend Proxy (Recommended)**.
5. Click **Test Connection**:
   - The backend probes TCP ports 80/81 and requests the HTTP stream.
   - Status badge displays `Online` with round-trip latency in milliseconds.
6. Click **Save Settings** to persist the configuration across reboots.
7. Confirm the live video stream displays in the preview canvas.

---

## 4. Diagnostic & Troubleshooting Checklist

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| **"Could not open serial port"** | COM port is open in Arduino Serial Monitor or another app | Close the Arduino IDE Serial Monitor or terminate conflicting processes. |
| **Sensor data stale (> 3s warning)** | ESP32 rebooted or cable disconnected | Check USB cable; dashboard will indicate stale telemetry. |
| **Camera shows "Offline - Connection timed out"** | ESP32-CAM and PC are on different Wi-Fi subnets | Connect both devices to the same 2.4 GHz Wi-Fi SSID. |
| **ESP32-CAM reboots continuously** | Insufficient power supply (Brownout detector triggered) | Power ESP32-CAM from a dedicated 5V 2A wall adapter, not laptop USB ports. |
| **Video preview blank on Chrome** | Browser blocked cross-origin MJPEG or mixed content | Set Stream Mode to **Backend Proxy** in Camera Settings. |
