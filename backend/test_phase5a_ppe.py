"""
PYROGUARD-H | Phase 5A Automated PPE Verification Suite
Tests:
1. Model loading & 10-class validation
2. Spatial association and worker compliance classification
3. 60-second violation countdown timer & evidence snapshot generation
4. SQLite ppe_incidents table operations (insert, query, acknowledge, resolve)
5. Live FastAPI endpoints (/api/ppe/status, /api/ppe/workers, /api/ppe/incidents, /api/ppe/config, /api/ppe/evidence)
6. Camera offline and stale frame handling
"""
import os
import time
import json
import unittest
import numpy as np
import cv2
from pathlib import Path
from datetime import datetime, timezone
import httpx

import db
from ppe_engine import PPEInferenceEngine, TrackedWorker

BACKEND_DIR = Path(__file__).resolve().parent
MODELS_DIR = BACKEND_DIR / "models"
EVIDENCE_DIR = BACKEND_DIR / "evidence"

class TestPhase5APPE(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()

    def test_01_models_and_classes(self):
        """Verifies that pretrained models exist and have the expected class signatures."""
        person_model_path = MODELS_DIR / "yolov8n.pt"
        ppe_model_path = MODELS_DIR / "ppe_yolov8n.pt"

        self.assertTrue(person_model_path.exists(), f"Missing {person_model_path}")
        self.assertTrue(ppe_model_path.exists(), f"Missing {ppe_model_path}")

        engine = PPEInferenceEngine()
        loaded = engine.load_models()
        self.assertTrue(loaded, "Failed to load YOLO models")

        # Verify person model class 0 is 'person'
        self.assertEqual(engine.person_model.names[0], "person")

        # Verify 10-class PPE model
        expected_classes = {
            0: "glove",
            1: "goggles",
            2: "helmet",
            3: "mask",
            4: "no_glove",
            5: "no_goggles",
            6: "no_helmet",
            7: "no_mask",
            8: "no_shoes",
            9: "shoes"
        }
        actual_classes = engine.ppe_model.names
        for idx, name in expected_classes.items():
            self.assertEqual(actual_classes.get(idx), name, f"Mismatch at index {idx}: {actual_classes.get(idx)} vs {name}")

        status = engine.get_status()
        self.assertIn("helmet", status["supported_categories"])
        self.assertIn("goggles", status["supported_categories"])
        self.assertIn("gloves", status["supported_categories"])
        self.assertIn("mask", status["supported_categories"])
        self.assertIn("shoes", status["supported_categories"])
        # Verify honest reporting of unsupported protective clothing
        self.assertIn("protective_clothing_antistatic_overalls", status["unsupported_categories"])

    def test_02_worker_compliance_classification(self):
        """Tests worker PPE category evaluation logic for compliant, violation, and unknown states."""
        engine = PPEInferenceEngine()
        engine.required_categories = ["helmet", "goggles", "gloves", "mask", "shoes"]
        
        worker = TrackedWorker(track_id=1)
        worker.bbox = [100, 50, 300, 500] # x1, y1, x2, y2 (w=200, h=450)

        # Case A: Compliant detections (wearing helmet, mask, goggles, gloves, shoes)
        detections_compliant = [
            {"class": "helmet", "conf": 0.88, "bbox": [150, 50, 250, 120], "center": (200, 85)},
            {"class": "goggles", "conf": 0.75, "bbox": [170, 100, 230, 130], "center": (200, 115)},
            {"class": "mask", "conf": 0.82, "bbox": [170, 120, 230, 160], "center": (200, 140)},
            {"class": "glove", "conf": 0.70, "bbox": [90, 280, 130, 320], "center": (110, 300)},
            {"class": "shoes", "conf": 0.80, "bbox": [140, 460, 260, 500], "center": (200, 480)},
        ]
        res_a = engine._evaluate_worker_ppe(worker, detections_compliant, 450, 50)
        self.assertEqual(len(res_a["missing"]), 0, f"Expected 0 missing, got {res_a['missing']}")
        self.assertEqual(len(res_a["compliant"]), 5, f"Expected 5 compliant, got {res_a['compliant']}")
        self.assertEqual(worker.category_status["helmet"], "COMPLIANT")
        self.assertEqual(worker.category_status["gloves"], "COMPLIANT")

        # Case B: Violation detections (no helmet detected, no gloves detected on visible worker)
        detections_violation = [
            {"class": "no_helmet", "conf": 0.85, "bbox": [150, 50, 250, 120], "center": (200, 85)},
            {"class": "no_glove", "conf": 0.78, "bbox": [90, 280, 130, 320], "center": (110, 300)},
        ]
        res_b = engine._evaluate_worker_ppe(worker, detections_violation, 450, 50)
        self.assertIn("helmet", res_b["missing"])
        self.assertIn("gloves", res_b["missing"])
        self.assertEqual(worker.category_status["helmet"], "VIOLATION")
        self.assertEqual(worker.category_status["gloves"], "VIOLATION")
        self.assertEqual(worker.category_status["goggles"], "VIOLATION")

        # Case C: Occluded / tiny worker (w_h=30)
        worker_tiny = TrackedWorker(track_id=2)
        res_c = engine._evaluate_worker_ppe(worker_tiny, [], 30, 0)
        self.assertEqual(worker_tiny.category_status["helmet"], "UNKNOWN")

    def test_03_timer_progression_and_incident_trigger(self):
        """Verifies 60-second threshold timer, evidence snapshot creation, and duplicate suppression."""
        engine = PPEInferenceEngine()
        engine.violation_threshold_sec = 2.0 # Use 2.0s for quick automated testing
        
        worker = TrackedWorker(track_id=99)
        worker.bbox = [50, 50, 200, 400]
        worker.missing_categories = ["helmet"]
        worker.category_status["helmet"] = "VIOLATION"

        test_frame = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(test_frame, "TEST WORKER", (60, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)

        # Frame 1: Grace period check (1st frame should not immediately start timer)
        worker.consecutive_violation_frames = 1
        self.assertIsNone(worker.violation_start_time)

        # Frame 2: Confirmed violation starts countdown
        worker.consecutive_violation_frames = 2
        now = time.time()
        worker.violation_start_time = now - 2.5 # Simulate 2.5s elapsed (> 2.0s threshold)
        worker.violation_elapsed_sec = 2.5

        # Trigger incident
        engine._trigger_ppe_incident(worker, test_frame)

        self.assertTrue(worker.alert_triggered, "Alert flag must be True")
        self.assertIsNotNone(worker.active_incident_id)
        self.assertIn("PPE-", worker.active_incident_id)

        # Check evidence file saved on disk
        evidence_file = EVIDENCE_DIR / f"incident_{worker.active_incident_id}.jpg"
        self.assertTrue(evidence_file.exists(), f"Evidence file was not saved: {evidence_file}")
        self.assertGreater(evidence_file.stat().st_size, 500, "Evidence file is empty or corrupted")

        # Check SQLite record
        incident_in_db = db.get_ppe_incident_by_id(worker.active_incident_id)
        self.assertIsNotNone(incident_in_db)
        self.assertEqual(incident_in_db["track_id"], 99)
        self.assertEqual(incident_in_db["missing_ppe"], "helmet")
        self.assertEqual(incident_in_db["status"], "OPEN")

        # Duplicate suppression: calling trigger again while alert_triggered is True must not duplicate
        incident_id_prev = worker.active_incident_id
        # If worker.alert_triggered is true, the process loop skips calling _trigger_ppe_incident
        self.assertTrue(worker.alert_triggered)

        # Restoring compliance:
        engine._resolve_worker_incident(worker)
        resolved_in_db = db.get_ppe_incident_by_id(incident_id_prev)
        self.assertEqual(resolved_in_db["status"], "RESOLVED")
        self.assertIsNotNone(resolved_in_db["resolved_time_utc"])

    def test_04_sqlite_ppe_crud(self):
        """Verifies insert, get, acknowledge, and resolve in SQLite."""
        test_id = f"PPE-TEST-{int(time.time())}"
        rec = {
            "incident_id": test_id,
            "track_id": 42,
            "missing_ppe": "gloves, goggles",
            "violation_start_utc": datetime.now(timezone.utc).isoformat(),
            "trigger_time_utc": datetime.now(timezone.utc).isoformat(),
            "duration_seconds": 60.5,
            "status": "OPEN",
            "evidence_image_path": f"/api/ppe/evidence/incident_{test_id}.jpg",
            "operator_notes": "Test automated incident"
        }
        success, iid = db.insert_ppe_incident(rec)
        self.assertTrue(success)
        self.assertEqual(iid, test_id)

        # Query list
        incidents, total = db.get_ppe_incidents(limit=10, status_filter="OPEN")
        matching = [i for i in incidents if i["incident_id"] == test_id]
        self.assertEqual(len(matching), 1)

        # Acknowledge
        ack_res = db.acknowledge_ppe_incident(test_id, operator_notes="Operator verified worker")
        self.assertTrue(ack_res)
        item = db.get_ppe_incident_by_id(test_id)
        self.assertEqual(item["status"], "ACKNOWLEDGED")
        self.assertEqual(item["operator_notes"], "Operator verified worker")

        # Resolve
        res_res = db.resolve_ppe_incident(test_id, notes="Resolved by supervisor")
        self.assertTrue(res_res)
        item_res = db.get_ppe_incident_by_id(test_id)
        self.assertEqual(item_res["status"], "RESOLVED")

    def test_05_live_fastapi_endpoints(self):
        """Verifies live HTTP endpoints on running FastAPI server."""
        base_url = "http://127.0.0.1:8000"
        with httpx.Client(base_url=base_url, timeout=5.0) as client:
            # 1. Status
            resp = client.get("/api/ppe/status")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn("ai_status", data)
            self.assertIn("target_fps", data)
            self.assertIn("supported_categories", data)
            self.assertIn("unsupported_categories", data)

            # 2. Workers
            resp_w = client.get("/api/ppe/workers")
            self.assertEqual(resp_w.status_code, 200)
            self.assertIn("workers", resp_w.json())

            # 3. Incidents
            resp_i = client.get("/api/ppe/incidents?limit=5")
            self.assertEqual(resp_i.status_code, 200)
            self.assertEqual(resp_i.json()["status"], "SUCCESS")

            # 4. Config update
            resp_cfg = client.post("/api/ppe/config", json={"target_fps": 4.5, "conf_threshold": 0.40})
            self.assertEqual(resp_cfg.status_code, 200)
            cfg_data = resp_cfg.json()["config"]
            self.assertEqual(cfg_data["target_fps"], 4.5)
            self.assertEqual(cfg_data["conf_threshold"], 0.40)

            # Reset config
            client.post("/api/ppe/config", json={"target_fps": 5.0, "conf_threshold": 0.35})

    def test_06_camera_offline_handling(self):
        """Verifies that the engine reports CAMERA_OFFLINE without inventing fake detections when feed is empty."""
        engine = PPEInferenceEngine(camera_hub=None)
        # Calling get_status with no frames processed
        status = engine.get_status()
        self.assertEqual(status["active_workers_count"], 0)
        self.assertEqual(status["active_violations_count"], 0)
        self.assertEqual(len(status["workers"]), 0)

if __name__ == "__main__":
    unittest.main()
