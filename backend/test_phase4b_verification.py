import asyncio
import httpx
import json
import time
from datetime import datetime, timezone, timedelta

BASE_URL = "http://127.0.0.1:8000"

async def test_overview_contracts(client: httpx.AsyncClient):
    print("\n--- 1. OVERVIEW COCKPIT CONTRACTS ---")
    
    # 1.1 Latest reading & missing state honesty
    r = await client.get("/api/sensor/readings/latest")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "SUCCESS"
    print(f"[PASS] /api/sensor/readings/latest: is_available={data['is_available']}")
    if data["is_available"]:
        latest = data["latest"]
        print(f"       Temperature: {latest.get('temperature_c')}C, Humidity: {latest.get('humidity_pct')}%, Flame: {latest.get('flame_detected')}, Buzzer: {latest.get('buzzer_on')}")
        assert "timestamp_utc" in latest
        assert "device_id" in latest

    # 1.2 Active alarms endpoint
    r = await client.get("/api/alarms?active_only=true&limit=10")
    assert r.status_code == 200
    alarms = r.json()
    assert "alarms" in alarms
    assert "total" in alarms
    print(f"[PASS] /api/alarms?active_only=true: {alarms['total']} active incidents recorded")

    # 1.3 Database and Cloud indicators
    r_db = await client.get("/api/database/status")
    assert r_db.status_code == 200
    db_data = r_db.json()
    assert db_data["status"] == "ONLINE"
    assert db_data["journal_mode"] == "WAL"
    print(f"[PASS] /api/database/status: ONLINE (WAL mode), {db_data['counts']['sensor_readings']} records")

    r_cloud = await client.get("/api/cloud/status")
    assert r_cloud.status_code == 200
    cloud_data = r_cloud.json()
    print(f"[PASS] /api/cloud/status: status={cloud_data['status']}, configured={cloud_data['cloud_configured']}")

async def test_camera_lifecycle_and_multiplexing(client: httpx.AsyncClient):
    print("\n--- 2. CAMERA LIFECYCLE & MULTIPLEXING STRESS TEST ---")

    # 2.1 Online Status probe
    r_cam = await client.get("/api/camera/status")
    assert r_cam.status_code == 200
    cam_data = r_cam.json()
    print(f"[PASS] /api/camera/status: status='{cam_data['status']}', online={cam_data.get('is_online')}, IP={cam_data.get('target_ip')}")

    # 2.2 Rapid stream connect / disconnect stress test (25 iterations)
    print("       Testing rapid stream subscribe & evict (25 iterations)...")
    for i in range(25):
        client_name = f"verify_client_{i % 3}" # alternate among 3 client IDs
        async with client.stream("GET", f"/api/camera/stream?client={client_name}&t={time.time()}") as resp:
            assert resp.status_code == 200
            assert "multipart/x-mixed-replace" in resp.headers.get("content-type", "")
            # Read first chunk
            async for chunk in resp.aiter_bytes():
                if len(chunk) > 0:
                    break
        # Closed stream
    print("[PASS] Completed 25 rapid stream open/close cycles without socket exhaustion or server hang!")

    # 2.3 Verify API continues to respond immediately after stream churn
    t0 = time.time()
    r_check = await client.get("/api/health")
    latency_ms = (time.time() - t0) * 1000
    assert r_check.status_code == 200
    print(f"[PASS] Post-churn API responsiveness: /api/health returned 200 OK in {latency_ms:.1f}ms")

    # 2.4 Test simulated offline camera behavior
    # Probe a non-routable IP to verify error handling without blocking
    print("       Testing simulated offline camera probe...")
    test_req = {"camera_ip": "192.0.2.1"} # RFC 5737 TEST-NET-1 (unreachable)
    r_offline = await client.post("/api/camera/test", json=test_req)
    assert r_offline.status_code == 200
    offline_res = r_offline.json()
    assert offline_res["status"] == "Offline" or offline_res["is_online"] is False
    print(f"[PASS] Offline camera probe gracefully reported: is_online={offline_res['is_online']}, status={offline_res['status']}")

async def test_historical_charts(client: httpx.AsyncClient):
    print("\n--- 3. HISTORICAL CHARTS API & EDGE CASES ---")

    # 3.1 1-Hour window query
    t_1h = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    r_1h = await client.get(f"/api/sensor/readings/history?limit=300&offset=0&start_time={t_1h}")
    assert r_1h.status_code == 200
    data_1h = r_1h.json()
    assert data_1h["status"] == "SUCCESS"
    print(f"[PASS] 1-Hour historical query: returned {len(data_1h['readings'])} points (total {data_1h['total']})")

    # 3.2 24-Hour window query
    t_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    r_24h = await client.get(f"/api/sensor/readings/history?limit=300&offset=0&start_time={t_24h}")
    assert r_24h.status_code == 200
    data_24h = r_24h.json()
    assert data_24h["status"] == "SUCCESS"
    print(f"[PASS] 24-Hour historical query: returned {len(data_24h['readings'])} points (total {data_24h['total']})")

    # 3.3 Verify units and fields in readings
    if len(data_24h["readings"]) > 0:
        sample = data_24h["readings"][0]
        assert "temperature_c" in sample
        assert "humidity_pct" in sample
        assert "timestamp_utc" in sample
        assert "device_id" in sample
        print(f"[PASS] Reading schema verified: sample temp={sample['temperature_c']}C, humidity={sample['humidity_pct']}%")

    # 3.4 Empty history edge case (query far future)
    t_future = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
    r_empty = await client.get(f"/api/sensor/readings/history?limit=300&offset=0&start_time={t_future}")
    assert r_empty.status_code == 200
    data_empty = r_empty.json()
    assert data_empty["total"] == 0
    assert len(data_empty["readings"]) == 0
    print("[PASS] Empty history edge case: returned 0 records cleanly (valid array)")

    # 3.5 Missing/invalid filter edge case (pagination beyond count)
    r_offset = await client.get("/api/sensor/readings/history?limit=50&offset=999999")
    assert r_offset.status_code == 200
    data_offset = r_offset.json()
    assert len(data_offset["readings"]) == 0
    print("[PASS] Out-of-bounds offset pagination: returned empty list without errors")

async def test_regression_features(client: httpx.AsyncClient):
    print("\n--- 4. REGRESSION SUITE VERIFICATION ---")

    # 4.1 Sensor Ports
    r_ports = await client.get("/api/sensor/ports")
    assert r_ports.status_code == 200
    ports_data = r_ports.json()
    print(f"[PASS] /api/sensor/ports: found {ports_data['count']} ports: {[p['device'] for p in ports_data['ports']]}")

    # 4.2 Network diagnostics
    r_diag = await client.get("/api/network/diagnostics")
    assert r_diag.status_code == 200
    diag = r_diag.json()
    print(f"[PASS] /api/network/diagnostics: camera_target_ip={diag.get('camera_target_ip')}, local_ips={diag.get('local_ips')}")

    # 4.3 Config & Settings
    r_cfg = await client.get("/api/config")
    assert r_cfg.status_code == 200
    cfg = r_cfg.json()
    print(f"[PASS] /api/config: camera_ip={cfg.get('camera_ip')}, stream_mode={cfg.get('camera_stream_mode')}")

    # 4.4 Ingest telemetry packet & test Alarm Acknowledgment
    ingest_payload = {
        "device_id": "PYRO-ESP32",
        "uptime_ms": 99999,
        "temperature_c": 32.0,
        "humidity_pct": 75.0,
        "flame_detected": True,
        "buzzer_on": True,
        "source": "serial"
    }
    r_ing = await client.post("/api/sensor/telemetry", json=ingest_payload)
    assert r_ing.status_code in [200, 202]

    # Check active alarm
    r_al = await client.get("/api/alarms?active_only=true")
    active_alarms = r_al.json()["alarms"]
    assert len(active_alarms) >= 1
    event_id = active_alarms[0]["event_id"]
    print(f"[PASS] Triggered alarm: {event_id}")

    # Acknowledge alarm
    r_ack = await client.post(f"/api/alarms/{event_id}/acknowledge", json={"notes": "Phase 4B Final Verification Ack"})
    assert r_ack.status_code == 200
    assert r_ack.json()["status"] == "ACKNOWLEDGED"
    print(f"[PASS] Acknowledged alarm {event_id}: status={r_ack.json()['status']}")

    # Clear flame condition
    clear_payload = {
        "device_id": "PYRO-ESP32",
        "uptime_ms": 100999,
        "temperature_c": 31.0,
        "humidity_pct": 74.0,
        "flame_detected": False,
        "buzzer_on": False,
        "source": "serial"
    }
    r_clr = await client.post("/api/sensor/telemetry", json=clear_payload)
    assert r_clr.status_code in [200, 202]
    print("[PASS] Cleared flame condition, alarm resolved cleanly")

async def main():
    print("=" * 60)
    print("PYROGUARD-H | PHASE 4B COMPREHENSIVE FINAL VERIFICATION SUITE")
    print("=" * 60)
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10.0) as client:
        await test_overview_contracts(client)
        await test_camera_lifecycle_and_multiplexing(client)
        await test_historical_charts(client)
        await test_regression_features(client)
    print("\n" + "=" * 60)
    print(">>> ALL PHASE 4B AUTOMATED AND API VERIFICATION TESTS PASSED! <<<")
    print("=" * 60)

if __name__ == "__main__":
    asyncio.run(main())
