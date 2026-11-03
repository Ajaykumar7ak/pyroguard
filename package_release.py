import os
import sys
import shutil
import time
import zipfile
import hashlib
from pathlib import Path

SOURCE_ROOT = Path(r"A:\pyro_guard")
RELEASE_ROOT = Path(r"A:\pyro_guard_release")
ZIP_OUTPUT = Path(r"A:\pyro_guard_release.zip")

def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def copy_file(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)

def create_directory_structure():
    log("Step 1: Preparing clean release directory structure...")
    if RELEASE_ROOT.exists():
        log(f"Removing existing {RELEASE_ROOT}...")
        shutil.rmtree(RELEASE_ROOT)
    RELEASE_ROOT.mkdir(parents=True, exist_ok=True)
    (RELEASE_ROOT / "backend").mkdir(parents=True, exist_ok=True)
    (RELEASE_ROOT / "backend" / "evidence").mkdir(parents=True, exist_ok=True)
    (RELEASE_ROOT / "backend" / "models").mkdir(parents=True, exist_ok=True)
    (RELEASE_ROOT / "runtime").mkdir(parents=True, exist_ok=True)

def assemble_portable_python():
    log("Step 2: Assembling standalone portable Python runtime...")
    base_prefix = Path(sys.base_prefix)
    runtime_dir = RELEASE_ROOT / "runtime"

    # 1. Copy core executables and DLLs from base Python
    for item in base_prefix.iterdir():
        if item.is_file():
            # Copy python.exe, pythonw.exe, and dlls
            copy_file(item, runtime_dir / item.name)

    # 2. Copy base DLLs
    log("Copying standard C extensions (DLLs)...")
    shutil.copytree(base_prefix / "DLLs", runtime_dir / "DLLs", dirs_exist_ok=True)

    # 3. Copy base Lib (standard library without site-packages)
    log("Copying standard library (Lib)...")
    def ignore_site_packages(d, files):
        if "site-packages" in files:
            return ["site-packages"]
        return []
    shutil.copytree(base_prefix / "Lib", runtime_dir / "Lib", ignore=ignore_site_packages, dirs_exist_ok=True)

    # 4. Copy project dependencies from venv site-packages
    venv_site_packages = SOURCE_ROOT / "backend" / "venv" / "Lib" / "site-packages"
    dst_site_packages = runtime_dir / "Lib" / "site-packages"
    log(f"Copying project dependencies from {venv_site_packages}...")
    shutil.copytree(venv_site_packages, dst_site_packages, dirs_exist_ok=True)

    log("Portable Python runtime assembled successfully.")

def assemble_backend():
    log("Step 3: Assembling backend application and configuration...")
    backend_src = SOURCE_ROOT / "backend"
    backend_dst = RELEASE_ROOT / "backend"

    # Copy Python code files
    code_files = [
        "main.py",
        "config.py",
        "db.py",
        "telemetry.py",
        "collector.py",
        "cloud_provider.py",
        "sync_worker.py",
        "ppe_engine.py",
        "requirements.txt"
    ]
    for cf in code_files:
        src = backend_src / cf
        if src.exists():
            copy_file(src, backend_dst / cf)

    # Copy settings.json
    if (backend_src / "settings.json").exists():
        copy_file(backend_src / "settings.json", backend_dst / "settings.json")

    # Copy .env.example
    if (backend_src / ".env.example").exists():
        copy_file(backend_src / ".env.example", backend_dst / ".env.example")

    # CRITICAL REQUIREMENT: Copy actual .env file (to backend/ and root)
    actual_env = backend_src / ".env"
    if actual_env.exists():
        log("Preserving actual .env file in backend/ and root release directory...")
        copy_file(actual_env, backend_dst / ".env")
        copy_file(actual_env, RELEASE_ROOT / ".env")
    else:
        raise FileNotFoundError(f"CRITICAL ERROR: {actual_env} not found!")

    # Copy all required ML model files
    log("Copying ML models to backend/models/...")
    models_src = backend_src / "models"
    for mf in models_src.glob("*.pt"):
        log(f"  Packaging model: {mf.name} ({mf.stat().st_size / (1024*1024):.2f} MB)")
        copy_file(mf, backend_dst / "models" / mf.name)

    # Copy compiled frontend dist into backend/dist
    log("Copying production frontend build to backend/dist/...")
    dist_src = SOURCE_ROOT / "frontend" / "dist"
    if not dist_src.exists():
        raise FileNotFoundError(f"Frontend dist not found at {dist_src}")
    shutil.copytree(dist_src, backend_dst / "dist", dirs_exist_ok=True)

def create_launchers():
    log("Step 4: Creating client one-click launcher scripts...")
    
    # START_PYROGUARD.bat
    start_bat = r"""@echo off
setlocal enabledelayedexpansion
title PyroGuard-H Industrial Safety Command Center
color 0B

echo ===============================================================================
echo                PYROGUARD-H ^| CLIENT COMMAND CENTER LAUNCHER
echo ===============================================================================
echo.

set "APP_DIR=%~dp0"
set "PYTHON_EXE=%APP_DIR%runtime\python.exe"
set "BACKEND_DIR=%APP_DIR%backend"

:: Verify bundled runtime exists
if not exist "%PYTHON_EXE%" (
    color 0C
    echo [ERROR] Bundled Python runtime not found at:
    echo         "%PYTHON_EXE%"
    echo.
    echo Please make sure the release package was extracted completely.
    pause
    exit /b 1
)

:: Check if already running on port 8000
netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [INFO] PyroGuard-H backend is already running on port 8000.
    echo Opening dashboard in default browser...
    start http://localhost:8000/
    goto :started
)

:: Ensure evidence folder exists
if not exist "%BACKEND_DIR%\evidence" mkdir "%BACKEND_DIR%\evidence"

:: Start Backend Server
echo [1/2] Starting PyroGuard-H Core Engine (Port 8000)...
cd /d "%BACKEND_DIR%"
start "PyroGuard Backend [Port 8000]" /min cmd /c ""%PYTHON_EXE%" -m uvicorn main:app --host 0.0.0.0 --port 8000 > server.log 2>&1"
cd /d "%APP_DIR%"

:: Wait for health check (max 30 seconds)
echo [2/2] Awaiting system initialization and model verification...
set /a ATTEMPTS=0
:health_check
ping -n 2 127.0.0.1 >nul
set /a ATTEMPTS+=1

:: Use python to test /api/health reliably without external curl dependencies
"%PYTHON_EXE%" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=1)" >nul 2>&1
if not errorlevel 1 goto :healthy

if !ATTEMPTS! geq 30 (
    color 0C
    echo.
    echo [WARNING] Server startup timed out after 30 seconds.
    echo Attempting to open dashboard anyway, or check backend console window for errors.
    goto :open_browser
)
goto :health_check

:healthy
echo       Backend health check passed successfully!

:open_browser
echo.
echo Launching Safety Command Center Dashboard in default browser...
start http://localhost:8000/

:started
echo.
echo ===============================================================================
echo  STATUS: PYROGUARD-H IS OPERATIONAL
echo.
echo  - Dashboard URL: http://localhost:8000/
echo  - API Docs:      http://localhost:8000/docs
echo.
echo  Controls:
echo  - Keep the minimized background task running during operation.
echo  - To cleanly stop all services, double-click 'STOP_PYROGUARD.bat'.
echo ===============================================================================
echo.
pause
"""
    with open(RELEASE_ROOT / "START_PYROGUARD.bat", "w", encoding="utf-8") as f:
        f.write(start_bat)

    # STOP_PYROGUARD.bat
    stop_bat = r"""@echo off
title Stop PyroGuard-H
color 0C

echo ===============================================================================
echo                STOPPING PYROGUARD-H SERVICES
echo ===============================================================================
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":8000 .*LISTENING"') do (
    echo Stopping PyroGuard-H process with PID %%a...
    taskkill /F /T /PID %%a >nul 2>&1
    set FOUND=1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":3000 .*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

if "%FOUND%"=="1" (
    echo.
    echo PyroGuard-H services have been stopped cleanly and port 8000 is released.
) else (
    echo No active PyroGuard-H server was found running on port 8000.
)

echo.
echo ===============================================================================
pause
"""
    with open(RELEASE_ROOT / "STOP_PYROGUARD.bat", "w", encoding="utf-8") as f:
        f.write(stop_bat)

def create_client_readme():
    log("Step 5: Writing client README_CLIENT.txt...")
    readme_text = """================================================================================
PYROGUARD-H | CLIENT QUICKSTART & OPERATIONAL MANUAL
================================================================================
Product: PyroGuard-H Industrial Safety Command Center
Package Version: 1.0.0-PROD
Release Build: Standalone Portable Windows Edition (AMD64)

1. SYSTEM REQUIREMENTS & PREREQUISITES
--------------------------------------------------------------------------------
- Operating System: Windows 10 (64-bit) or Windows 11 (64-bit).
- Hardware: Minimum 4-Core CPU, 8 GB RAM, 2 GB available disk space.
- NO PREREQUISITES REQUIRED: Python, Node.js, PyTorch, Ultralytics, and OpenCV
  are 100% pre-bundled inside the 'runtime' directory. You do NOT need to
  install any compilers, package managers, or language runtimes.

2. EXTRACTION INSTRUCTIONS
--------------------------------------------------------------------------------
1. Extract the entire ZIP archive to any preferred folder on your laptop
   (e.g., C:\\PyroGuard or D:\\PyroGuard).
2. Ensure you have extracted all files from the ZIP before launching.
   Do NOT run directly from inside the compressed archive viewer.

3. STARTING THE APPLICATION (ONE-CLICK)
--------------------------------------------------------------------------------
1. Open the extracted folder.
2. Double-click "START_PYROGUARD.bat".
3. The launcher will automatically start the background server, verify the
   machine vision pipeline, and open the dashboard in your default browser at:
   http://localhost:8000/

4. STOPPING THE APPLICATION (ONE-CLICK)
--------------------------------------------------------------------------------
1. Double-click "STOP_PYROGUARD.bat".
2. This cleanly releases port 8000, flushes local database logs, and terminates
   the background service.

5. SENSOR NODE (ESP32) CONFIGURATION
--------------------------------------------------------------------------------
- Connect the ESP32 sensor node via USB.
- Default Baud Rate: 115200 baud (Firmware standard).
- Default COM Port: COM4.
- If your computer assigns a different port (e.g., COM3, COM5, COM7):
  1. Open the dashboard (http://localhost:8000/).
  2. Click the "Device Connections" tab in the top navigation bar.
  3. Click "Scan Ports", select your Silicon Labs CP210x or CH340 port,
     and click "Connect Device".
  4. Changes are automatically saved to 'backend/settings.json'.

6. ESP32-CAM (CAMERA SURVEILLANCE) CONFIGURATION
--------------------------------------------------------------------------------
- Default Camera IPv4: 10.131.84.41 (or configured hotspot address).
- Default Stream URL: http://<camera_ip>:81/stream
- To change the camera address:
  1. Click the "Camera Feeds" tab in the top navigation bar.
  2. Enter the new IP address in the "ESP32-CAM Local IPv4 Address" field.
  3. Click "Test Connection" to independently probe port 80 (web) and port 81 (MJPEG).
  4. Click "Save Settings".
- Note on ESP32-CAM: The OV2640 hardware only supports 1 concurrent MJPEG client.
  If another tab or device is viewing port 81, switch to "Snapshot Refresh" mode
  in the Camera Feeds panel.

7. ADJUSTING THE PPE VIOLATION THRESHOLD
--------------------------------------------------------------------------------
- The system continuously tracks workers and checks for missing required PPE.
- Violation Threshold: Configurable to 5s, 10s, 30s, or 60s directly on the
  Overview cockpit using the interactive threshold selector buttons.
- Default setting: 10.0 seconds.
- Sustained violations beyond the threshold automatically capture an annotated
  evidence JPEG snapshot and log an incident event into SQLite.

8. TROUBLESHOOTING & COMMON NOTICES
--------------------------------------------------------------------------------
- Windows Defender / SmartScreen:
  If Windows prompts "Windows protected your PC" when launching the batch file,
  click "More info" and select "Run anyway".
- Camera Disconnection:
  If the camera drops off Wi-Fi, the dashboard will display a clear "Offline"
  badge and fallback screen without crashing the application.
- Sensor Disconnection:
  If the USB cable is unplugged, the sensor status badge will display
  "DISCONNECTED" and temperature/humidity will honestly show "N/A".
- Machine Learning Models:
  All models (yolov8n.pt, ppe_yolov8n.pt, helmet_iam_tsr.pt, helmet_sharath.pt)
  are pre-cached in 'backend/models/'. The application never downloads weights
  at runtime.

9. DATA STORAGE & EVIDENCE PATHS
--------------------------------------------------------------------------------
- Local SQLite Database: Stored at 'backend/pyroguard.db' (Write-Ahead Logging mode).
- Evidence Snapshots: Stored at 'backend/evidence/incident_*.jpg'.
- Configuration: Stored at 'backend/settings.json'.

10. DATABASE & CLOUD SYNCHRONIZATION
--------------------------------------------------------------------------------
- Local-First Architecture: Host SQLite is the primary source of truth.
  Sensor telemetry and local alarms function 100% offline without internet.
- Supabase Cloud Backup: If internet connectivity is available, the background
  worker automatically synchronizes telemetry and alarm events every 30 seconds.
- You can inspect the synchronization queue status in the "Cloud Backup" tab.

11. SECURITY & CREDENTIALS PROTECTION (.env)
--------------------------------------------------------------------------------
- The included '.env' file contains pre-configured database connection settings.
- This package should be treated as confidential. Do not upload the ZIP archive
  to public repositories or insecure cloud storage.
- If the credentials are compromised, rotate the service key immediately in your
  database dashboard.

12. INTERNET CONNECTIVITY REQUIREMENTS
--------------------------------------------------------------------------------
- Offline Capabilities: Live camera surveillance, YOLOv8 PPE detection,
  USB sensor acquisition, local alarms, SQLite storage, and hardware buzzer
  require ZERO internet connection.
- Cloud Backup: Only the optional 30-second Supabase backup requires internet.

13. LICENSE NOTICES
--------------------------------------------------------------------------------
- YOLOv8 / Ultralytics: Licensed under AGPL-3.0 / Commercial.
- PyTorch: Licensed under Modified BSD.
- OpenCV: Licensed under Apache 2.0.
- FastAPI / Starlette: Licensed under MIT.
- React: Licensed under MIT.
- PyroGuard-H Application: Proprietary Client Delivery.

14. PROTOTYPE NOTICE
--------------------------------------------------------------------------------
PyroGuard-H is an engineering capstone prototype designed for live demonstration
and evaluation. It is not an OSHA or NFPA certified life-safety device.
================================================================================
"""
    with open(RELEASE_ROOT / "README_CLIENT.txt", "w", encoding="utf-8") as f:
        f.write(readme_text)

def create_zip_archive():
    log("Step 6: Creating final release ZIP archive...")
    log(f"Compressing {RELEASE_ROOT} into {ZIP_OUTPUT}...")
    
    start_t = time.time()
    total_files = 0
    with zipfile.ZipFile(ZIP_OUTPUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(RELEASE_ROOT):
            for file in files:
                file_path = Path(root) / file
                arcname = file_path.relative_to(RELEASE_ROOT)
                zf.write(file_path, arcname)
                total_files += 1
                if total_files % 1000 == 0:
                    log(f"  Archived {total_files} files...")

    duration = time.time() - start_t
    zip_size_mb = ZIP_OUTPUT.stat().st_size / (1024 * 1024)
    log(f"ZIP archive created in {duration:.1f}s: {ZIP_OUTPUT} ({zip_size_mb:.2f} MB, {total_files} files)")

def generate_checksums():
    log("Step 7: Calculating SHA-256 checksums...")
    hasher = hashlib.sha256()
    with open(ZIP_OUTPUT, "rb") as f:
        while chunk := f.read(1024 * 1024 * 8):
            hasher.update(chunk)
    zip_sha = hasher.hexdigest()
    
    sha_file = Path(r"A:\pyro_guard_release.sha256")
    with open(sha_file, "w", encoding="utf-8") as f:
        f.write(f"{zip_sha}  {ZIP_OUTPUT.name}\n")
    log(f"SHA-256: {zip_sha}")

if __name__ == "__main__":
    try:
        t0 = time.time()
        create_directory_structure()
        assemble_portable_python()
        assemble_backend()
        create_launchers()
        create_client_readme()
        create_zip_archive()
        generate_checksums()
        log(f"Release packaging completed successfully in {time.time() - t0:.1f}s!")
    except Exception as e:
        log(f"ERROR during packaging: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
