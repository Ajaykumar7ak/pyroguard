import time
import json
import httpx
import websockets
import asyncio

BASE_URL = "http://127.0.0.1:8000"
WS_URL = "ws://127.0.0.1:8000/ws/telemetry"

async def test_api():
    print("Testing Live FastAPI Endpoints on", BASE_URL)
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=5.0) as client:
        # 1. Health
        r = await client.get("/api/health")
        assert r.status_code == 200, f"Health check failed: {r.status_code}"
        health = r.json()
        print("[PASS] /api/health:", health["status"], "DB:", health["database"]["status"])
        assert health["database"]["status"] in ["ONLINE", "UNINITIALIZED"]

        # 2. Database Status
        r = await client.get("/api/database/status")
        assert r.status_code == 200
        db_stat = r.json()
        print("[PASS] /api/database/status:", f"Size: {db_stat['file_size_kb']} KB, Journal: {db_stat['journal_mode']}, Readings: {db_stat['counts']['sensor_readings']}")
        assert db_stat["integrity"] == "OK"
        assert db_stat["local_first_offline_ready"] is True

        # 3. Sensor Status
        r = await client.get("/api/sensor/status")
        assert r.status_code == 200
        s_stat = r.json()
        print("[PASS] /api/sensor/status:", s_stat["status"])

        # 4. Ingest Telemetry via POST /api/sensor/telemetry (Simulating incoming reading)
        payload = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 77123,
            "temperature_c": 31.8,
            "humidity_pct": 78.8,
            "flame_detected": False,
            "buzzer_on": False,
            "source": "serial"
        }
        r = await client.post("/api/sensor/telemetry", json=payload)
        assert r.status_code in [200, 202]
        ingest_res = r.json()
        print("[PASS] POST /api/sensor/telemetry:", ingest_res["status"])

        # Ingest a Flame Hazard packet to trigger active alarm transition
        flame_payload = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 79123,
            "temperature_c": 33.5,
            "humidity_pct": 72.0,
            "flame_detected": True,
            "buzzer_on": True,
            "source": "serial"
        }
        r_flame = await client.post("/api/sensor/telemetry", json=flame_payload)
        print("[PASS] POST /api/sensor/telemetry (Flame Active):", r_flame.json()["status"])

        # 5. Latest Reading
        r = await client.get("/api/sensor/readings/latest")
        assert r.status_code == 200
        latest = r.json()
        print("[PASS] /api/sensor/readings/latest:", "Found" if latest["is_available"] else "None")
        assert latest["latest"]["temperature_c"] == 33.5
        assert latest["latest"]["flame_detected"] is True

        # 6. History with Pagination
        r = await client.get("/api/sensor/readings/history?limit=10&offset=0")
        assert r.status_code == 200
        history = r.json()
        print(f"[PASS] /api/sensor/readings/history: Total {history['total']}, Returned {len(history['readings'])}")
        assert history["total"] >= 1

        # 7. Alarms
        r = await client.get("/api/alarms?active_only=true")
        assert r.status_code == 200
        alarms_data = r.json()
        print(f"[PASS] /api/alarms (Active): {alarms_data['total']} active incidents")
        assert alarms_data["total"] >= 1
        active_event_id = alarms_data["alarms"][0]["event_id"]

        # 8. Acknowledge Alarm
        r = await client.post(f"/api/alarms/{active_event_id}/acknowledge", json={"notes": "E2E Test Verified"})
        assert r.status_code == 200
        ack_res = r.json()
        print(f"[PASS] POST /api/alarms/{active_event_id}/acknowledge: {ack_res['status']}")

        # 9. Resolve Flame Hazard (send flame_detected = False)
        clear_payload = {
            "device_id": "PYRO-ESP32",
            "uptime_ms": 81123,
            "temperature_c": 30.0,
            "humidity_pct": 70.0,
            "flame_detected": False,
            "buzzer_on": False,
            "source": "serial"
        }
        await client.post("/api/sensor/telemetry", json=clear_payload)
        r_after = await client.get("/api/alarms?active_only=true")
        assert r_after.json()["total"] == 0, "Alarm should be resolved once flame clears"
        print("[PASS] Flame hazard incident cleanly resolved.")

        # 10. Devices
        r = await client.get("/api/devices")
        assert r.status_code == 200
        dev_data = r.json()
        print(f"[PASS] /api/devices: {dev_data['count']} devices tracked")
        assert dev_data["count"] >= 1

        # 11. Camera Status (Lightweight Probe)
        r = await client.get("/api/camera/status")
        assert r.status_code == 200
        cam_stat = r.json()
        print(f"[PASS] /api/camera/status: {cam_stat['status']} (Target IP: {cam_stat.get('target_ip')})")
        assert "status" in cam_stat
        assert "is_online" in cam_stat

async def test_websocket():
    print("Testing WebSocket /ws/telemetry...")
    async with websockets.connect(WS_URL) as ws:
        # Receive initial init frame
        init_frame = await asyncio.wait_for(ws.recv(), timeout=3.0)
        init_data = json.loads(init_frame)
        print("[PASS] WebSocket Received Init Message:", init_data["type"], "DB Status:", init_data.get("database_status"))
        assert init_data["type"] == "init"

        # Ping
        await ws.send("ping")
        pong = await asyncio.wait_for(ws.recv(), timeout=3.0)
        assert pong == "pong"
        print("[PASS] WebSocket Ping/Pong: pong received successfully")

async def main():
    await test_api()
    await test_websocket()
    print("\n>>> ALL E2E API AND WEBSOCKET TESTS PASSED SUCCESSFULLY! <<<")

if __name__ == "__main__":
    asyncio.run(main())
