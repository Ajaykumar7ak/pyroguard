import os
import time
import json
import uuid
import logging
import threading
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple, Set

import cv2
import numpy as np
from ultralytics import YOLO

import db

logger = logging.getLogger("pyroguard.ppe_engine")

# Directory paths
BACKEND_DIR = Path(__file__).resolve().parent
MODELS_DIR = BACKEND_DIR / "models"
EVIDENCE_DIR = BACKEND_DIR / "evidence"
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

class TrackedWorker:
    """Maintains state, tracking history, and violation countdowns for a worker."""
    def __init__(self, track_id: int):
        self.track_id = track_id
        self.bbox: List[int] = [0, 0, 0, 0] # [x1, y1, x2, y2]
        self.first_seen_time: float = time.time()
        self.last_seen_time: float = time.time()
        
        # Category states: helmet, goggles, gloves, mask, shoes
        # Each category has status: 'COMPLIANT', 'VIOLATION', 'UNKNOWN'
        self.category_status: Dict[str, str] = {
            "helmet": "UNKNOWN",
            "goggles": "UNKNOWN",
            "gloves": "UNKNOWN",
            "mask": "UNKNOWN",
            "shoes": "UNKNOWN"
        }
        self.category_conf: Dict[str, float] = {k: 0.0 for k in self.category_status}
        
        # Violation tracking
        self.violation_start_time: Optional[float] = None
        self.violation_elapsed_sec: float = 0.0
        self.consecutive_violation_frames: int = 0
        self.consecutive_compliant_frames: int = 0
        self.alert_triggered: bool = False # Prevents duplicate alerts for the same continuous incident
        self.active_incident_id: Optional[str] = None
        self.missing_categories: List[str] = []
        self.compliant_categories: List[str] = []
        self.unknown_categories: List[str] = list(self.category_status.keys())
        self.evidence_path: Optional[str] = None

class PPEInferenceEngine:
    """
    Budget-Friendly Local PPE Monitoring Inference Engine.
    Runs locally on the host machine using lightweight pretrained YOLOv8n models:
    - Worker detection & tracking: models/yolov8n.pt (COCO class 0: person + ByteTrack)
    - 10-Class PPE detection: models/ppe_yolov8n.pt (helmet, goggles, glove, mask, shoes, and violation classes)
    - Zero duplicate camera connections: pulls directly from CameraStreamHub._latest_frame.
    - Configurable FPS, graceful degradation on stale feed/offline camera, 60-second incident countdown.
    """
    def __init__(self, camera_hub=None):
        self.camera_hub = camera_hub
        self.models_loaded: bool = False
        self.person_model: Optional[YOLO] = None
        self.ppe_model: Optional[YOLO] = None
        self.helmet_model: Optional[YOLO] = None
        
        # Configuration
        self.target_fps: float = 5.0
        self.conf_threshold: float = 0.25
        self.violation_threshold_sec: float = 10.0 # 10-second violation countdown threshold
        self.required_categories: List[str] = ["helmet", "goggles", "gloves"]
        self.max_evidence_files: int = 50
        self.is_running: bool = False
        
        # Worker state management
        self.tracked_workers: Dict[int, TrackedWorker] = {}
        self.worker_lock = threading.Lock()
        self._incident_listeners: List[Any] = []
        # Performance metrics
        self.ai_status: str = "INITIALIZING" # INITIALIZING, ONLINE, IDLE, STALE_FEED, CAMERA_OFFLINE, MODEL_UNAVAILABLE
        self.actual_fps: float = 0.0
        self.latency_ms: float = 0.0
        self.last_processed_frame_time: Optional[float] = None
        self.total_frames_processed: int = 0
        self.active_violations_count: int = 0
        
        # Annotated frame buffer for live visualization stream
        self._latest_annotated_frame: Optional[bytes] = None
        self._annotated_subscribers: List[asyncio.Queue] = []
        self._annotated_lock = asyncio.Lock()
        
        # Background worker thread
        self._worker_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def register_incident_listener(self, listener):
        """Registers a callback function to be called when PPE incidents trigger or resolve."""
        self._incident_listeners.append(listener)

    def load_models(self) -> bool:
        """Loads lightweight YOLO models into memory."""
        try:
            person_model_path = MODELS_DIR / "yolov8n.pt"
            ppe_model_path = MODELS_DIR / "ppe_yolov8n.pt"

            if not person_model_path.exists():
                logger.info("Downloading yolov8n.pt person model...")
                self.person_model = YOLO("yolov8n.pt")
                # Save locally in models dir
                self.person_model.save(str(person_model_path))
            else:
                self.person_model = YOLO(str(person_model_path))

            if not ppe_model_path.exists():
                logger.error(f"PPE model not found at {ppe_model_path}")
                self.ai_status = "MODEL_UNAVAILABLE"
                return False

            self.ppe_model = YOLO(str(ppe_model_path))
            
            # Load specialized helmet model (supports motorcycle helmets, full-face, and safety hardhats)
            helmet_model_path = MODELS_DIR / "helmet_iam_tsr.pt"
            if helmet_model_path.exists():
                try:
                    self.helmet_model = YOLO(str(helmet_model_path))
                    logger.info("Specialized helmet & headgear model loaded successfully.")
                except Exception as e:
                    logger.warning(f"Could not load specialized helmet model: {e}")

            self.models_loaded = True
            self.ai_status = "IDLE"
            logger.info("PPE models loaded successfully.")
            return True
        except Exception as e:
            logger.error(f"Failed to load PPE models: {e}", exc_info=True)
            self.ai_status = "MODEL_UNAVAILABLE"
            return False

    def start(self):
        """Starts the background AI inference loop."""
        if self.is_running:
            return
        if not self.models_loaded:
            if not self.load_models():
                return
        
        self.is_running = True
        self._stop_event.clear()
        self._worker_thread = threading.Thread(target=self._inference_loop, daemon=True, name="PPEInferenceThread")
        self._worker_thread.start()
        logger.info(f"PPE Inference Engine started (Target FPS: {self.target_fps}).")

    def stop(self):
        """Stops the background AI inference loop."""
        self.is_running = False
        self._stop_event.set()
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=2.0)
        self.ai_status = "STOPPED"
        logger.info("PPE Inference Engine stopped.")

    def update_config(
        self,
        target_fps: Optional[float] = None,
        conf_threshold: Optional[float] = None,
        violation_threshold_sec: Optional[float] = None,
        required_categories: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Dynamically updates PPE inference engine settings."""
        if target_fps is not None:
            self.target_fps = max(1.0, min(15.0, float(target_fps)))
        if conf_threshold is not None:
            self.conf_threshold = max(0.15, min(0.90, float(conf_threshold)))
        if violation_threshold_sec is not None:
            self.violation_threshold_sec = max(3.0, min(300.0, float(violation_threshold_sec)))
        if required_categories is not None:
            valid_cats = {"helmet", "goggles", "gloves", "mask", "shoes"}
            self.required_categories = [c for c in required_categories if c in valid_cats]

        return {
            "target_fps": self.target_fps,
            "conf_threshold": self.conf_threshold,
            "violation_threshold_sec": self.violation_threshold_sec,
            "required_categories": self.required_categories
        }

    def _inference_loop(self):
        """Continuous inference worker loop operating on the camera hub's latest frame."""
        fps_tracker: List[float] = []
        last_frame_bytes: Optional[bytes] = None
        last_frame_time = time.time()

        while not self._stop_event.is_set():
            t_cycle_start = time.time()

            # 1. Check if camera hub has a frame
            frame_bytes = getattr(self.camera_hub, "_latest_frame", None) if self.camera_hub else None
            
            if frame_bytes is None:
                self.ai_status = "CAMERA_OFFLINE"
                time.sleep(0.5)
                continue

            # Detect stale frames (if camera stopped publishing new frames)
            if frame_bytes == last_frame_bytes:
                if time.time() - last_frame_time > 3.0:
                    self.ai_status = "STALE_FEED"
                time.sleep(0.1)
                continue
            
            last_frame_bytes = frame_bytes
            last_frame_time = time.time()

            # 2. Decode JPEG frame to OpenCV image
            try:
                np_arr = np.frombuffer(frame_bytes, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                if frame is None or frame.size == 0:
                    continue
            except Exception as e:
                logger.debug(f"Frame decode error: {e}")
                continue

            # 3. Perform Inference
            t_infer_start = time.time()
            annotated_frame = self._process_frame(frame)
            infer_elapsed = time.time() - t_infer_start
            self.latency_ms = round(infer_elapsed * 1000, 1)

            # 4. Encode and store annotated frame for the live stream
            try:
                ret, enc_jpg = cv2.imencode(".jpg", annotated_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                if ret:
                    self._latest_annotated_frame = enc_jpg.tobytes()
            except Exception:
                pass

            # 5. Performance and FPS tracking
            now = time.time()
            fps_tracker.append(now)
            fps_tracker = [t for t in fps_tracker if now - t <= 2.0]
            if len(fps_tracker) > 1:
                self.actual_fps = round((len(fps_tracker) - 1) / (fps_tracker[-1] - fps_tracker[0]), 1)
            
            self.last_processed_frame_time = now
            self.total_frames_processed += 1
            self.ai_status = "ONLINE"

            # 6. Regulate target inference FPS
            desired_interval = 1.0 / self.target_fps
            elapsed_cycle = time.time() - t_cycle_start
            sleep_time = max(0.01, desired_interval - elapsed_cycle)
            time.sleep(sleep_time)

    def _process_frame(self, frame: np.ndarray) -> np.ndarray:
        """Processes a single frame for worker tracking and PPE classification."""
        orig_h, orig_w = frame.shape[:2]
        annotated_frame = frame.copy()
        now = time.time()

        # Step 1: Detect and track persons (class 0) using YOLOv8 ByteTrack
        try:
            person_results = self.person_model.track(
                frame, 
                classes=[0], 
                persist=True, 
                imgsz=416, 
                conf=0.40, 
                verbose=False
            )
        except Exception as e:
            logger.debug(f"Person tracking error: {e}")
            return annotated_frame

        detected_workers_in_frame: Dict[int, List[int]] = {}

        if person_results and len(person_results) > 0 and person_results[0].boxes is not None:
            boxes = person_results[0].boxes
            for i, box in enumerate(boxes):
                # Retrieve bounding box coordinates
                xyxy = box.xyxy[0].cpu().numpy().astype(int)
                x1, y1, x2, y2 = max(0, xyxy[0]), max(0, xyxy[1]), min(orig_w, xyxy[2]), min(orig_h, xyxy[3])
                
                # Check track ID
                if box.id is not None:
                    track_id = int(box.id[0].item())
                else:
                    track_id = i + 1 # Fallback ID if tracker is stabilizing

                detected_workers_in_frame[track_id] = [x1, y1, x2, y2]

        # Step 2: Detect PPE items across the frame using the 10-class PPE model
        ppe_detections: List[Dict[str, Any]] = []
        if len(detected_workers_in_frame) > 0:
            try:
                # 1. Full-frame PPE inference pass
                ppe_results = self.ppe_model(
                    frame, 
                    imgsz=416, 
                    conf=self.conf_threshold, 
                    verbose=False
                )
                if ppe_results and len(ppe_results) > 0 and ppe_results[0].boxes is not None:
                    ppe_boxes = ppe_results[0].boxes
                    for pbox in ppe_boxes:
                        pxyxy = pbox.xyxy[0].cpu().numpy().astype(int)
                        cls_idx = int(pbox.cls[0].item())
                        cls_name = self.ppe_model.names.get(cls_idx, "unknown")
                        conf = float(pbox.conf[0].item())
                        
                        px1, py1, px2, py2 = max(0, pxyxy[0]), max(0, pxyxy[1]), min(orig_w, pxyxy[2]), min(orig_h, pxyxy[3])
                        cx = (px1 + px2) / 2
                        cy = (py1 + py2) / 2

                        ppe_detections.append({
                            "class": cls_name,
                            "conf": conf,
                            "bbox": [px1, py1, px2, py2],
                            "center": (cx, cy)
                        })

                # 2. Specialized helmet & headgear pass (detects hardhats, industrial helmets, and motorcycle/full-face helmets)
                if self.helmet_model is not None:
                    try:
                        h_res = self.helmet_model(frame, imgsz=416, conf=0.20, verbose=False)
                        if h_res and len(h_res) > 0 and h_res[0].boxes is not None:
                            for hbox in h_res[0].boxes:
                                hxyxy = hbox.xyxy[0].cpu().numpy().astype(int)
                                hcls_idx = int(hbox.cls[0].item())
                                hcls_name = self.helmet_model.names.get(hcls_idx, "")
                                hconf = float(hbox.conf[0].item())

                                hx1, hy1, hx2, hy2 = max(0, hxyxy[0]), max(0, hxyxy[1]), min(orig_w, hxyxy[2]), min(orig_h, hxyxy[3])
                                hcx = (hx1 + hx2) / 2
                                hcy = (hy1 + hy2) / 2

                                # Map 'With Helmet' to 'helmet' and 'Without Helmet' to 'no_helmet'
                                if "with" in hcls_name.lower() and "without" not in hcls_name.lower():
                                    mapped_cls = "helmet"
                                elif "without" in hcls_name.lower() or "no" in hcls_name.lower():
                                    mapped_cls = "no_helmet"
                                else:
                                    mapped_cls = "helmet"

                                ppe_detections.append({
                                    "class": mapped_cls,
                                    "conf": hconf,
                                    "bbox": [hx1, hy1, hx2, hy2],
                                    "center": (hcx, hcy)
                                })
                    except Exception as e:
                        logger.debug(f"Specialized helmet model error: {e}")

                # 3. High-resolution worker-crop PPE inference pass for small equipment (helmet, goggles, gloves)
                for tid, bbox in detected_workers_in_frame.items():
                    wx1, wy1, wx2, wy2 = bbox
                    w_w = wx2 - wx1
                    w_h = wy2 - wy1
                    if w_w >= 40 and w_h >= 40:
                        crop = frame[wy1:wy2, wx1:wx2]
                        c_res = self.ppe_model(crop, imgsz=320, conf=self.conf_threshold, verbose=False)
                        if c_res and len(c_res) > 0 and c_res[0].boxes is not None:
                            for cbox in c_res[0].boxes:
                                cxyxy = cbox.xyxy[0].cpu().numpy().astype(int)
                                ccls_idx = int(cbox.cls[0].item())
                                ccls_name = self.ppe_model.names.get(ccls_idx, "unknown")
                                cconf = float(cbox.conf[0].item())

                                g_x1 = max(0, wx1 + cxyxy[0])
                                g_y1 = max(0, wy1 + cxyxy[1])
                                g_x2 = min(orig_w, wx1 + cxyxy[2])
                                g_y2 = min(orig_h, wy1 + cxyxy[3])
                                g_cx = (g_x1 + g_x2) / 2
                                g_cy = (g_y1 + g_y2) / 2

                                ppe_detections.append({
                                    "class": ccls_name,
                                    "conf": cconf,
                                    "bbox": [g_x1, g_y1, g_x2, g_y2],
                                    "center": (g_cx, g_cy)
                                })
            except Exception as e:
                logger.debug(f"PPE detection error: {e}")

        # Step 3: Associate PPE items with tracked workers
        with self.worker_lock:
            # Clean up stale workers not seen in > 8 seconds
            stale_threshold = 8.0
            stale_ids = [tid for tid, w in self.tracked_workers.items() if now - w.last_seen_time > stale_threshold]
            for tid in stale_ids:
                del self.tracked_workers[tid]

            active_violations = 0

            # Update existing or register new workers
            for track_id, bbox in detected_workers_in_frame.items():
                if track_id not in self.tracked_workers:
                    self.tracked_workers[track_id] = TrackedWorker(track_id)
                
                worker = self.tracked_workers[track_id]
                worker.bbox = bbox
                worker.last_seen_time = now
                
                wx1, wy1, wx2, wy2 = bbox
                w_w = wx2 - wx1
                w_h = wy2 - wy1

                # Find all PPE detections belonging to this worker
                worker_ppe: List[Dict[str, Any]] = []
                for ppe in ppe_detections:
                    cx, cy = ppe["center"]
                    # Spatial containment with generous margin
                    if (wx1 - 0.15 * w_w <= cx <= wx2 + 0.15 * w_w) and (wy1 - 0.10 * w_h <= cy <= wy2 + 0.10 * w_h):
                        worker_ppe.append(ppe)

                # Classify compliance for each PPE category
                compliance = self._evaluate_worker_ppe(worker, worker_ppe, w_h, wy1)
                
                # Check overall worker compliance
                has_violation = len(compliance["missing"]) > 0
                is_fully_compliant = not has_violation and len(compliance["compliant"]) >= len(self.required_categories)

                # Update 60-Second Violation Timer
                if has_violation:
                    worker.consecutive_violation_frames += 1
                    worker.consecutive_compliant_frames = 0
                    
                    if worker.consecutive_violation_frames >= 2: # Grace period of 2 frames to avoid single-frame glitch
                        if worker.violation_start_time is None:
                            worker.violation_start_time = now
                        worker.violation_elapsed_sec = round(now - worker.violation_start_time, 1)
                        active_violations += 1

                        # Trigger 60-Second Incident Workflow
                        if worker.violation_elapsed_sec >= self.violation_threshold_sec and not worker.alert_triggered:
                            self._trigger_ppe_incident(worker, frame)
                else:
                    worker.consecutive_compliant_frames += 1
                    if worker.consecutive_compliant_frames >= 5: # Sustained compliance for 5 frames resets violation
                        if worker.active_incident_id:
                            self._resolve_worker_incident(worker)
                        worker.violation_start_time = None
                        worker.violation_elapsed_sec = 0.0
                        worker.alert_triggered = False
                        worker.consecutive_violation_frames = 0

                # Step 4: Draw Visual Annotations on Output Frame
                self._draw_worker_annotations(annotated_frame, worker, compliance, worker_ppe)

            self.active_violations_count = active_violations

        # Step 5: Draw Global HUD Banner
        self._draw_hud_banner(annotated_frame, len(detected_workers_in_frame), self.active_violations_count)

        return annotated_frame

    def _evaluate_worker_ppe(
        self, 
        worker: TrackedWorker, 
        worker_ppe: List[Dict[str, Any]], 
        w_h: int, 
        wy1: int
    ) -> Dict[str, Any]:
        """Evaluates detected PPE items against required safety categories."""
        found_classes = {p["class"]: p["conf"] for p in worker_ppe}
        
        missing: List[str] = []
        compliant: List[str] = []
        unknown: List[str] = []

        # Category 1: Safety Helmet
        if "helmet" in self.required_categories:
            if "helmet" in found_classes:
                worker.category_status["helmet"] = "COMPLIANT"
                worker.category_conf["helmet"] = found_classes["helmet"]
                compliant.append("helmet")
            elif "no_helmet" in found_classes:
                worker.category_status["helmet"] = "VIOLATION"
                worker.category_conf["helmet"] = found_classes["no_helmet"]
                missing.append("helmet")
            else:
                # If neither helmet nor no_helmet is explicitly observed on the visible head:
                if w_h >= 60:
                    worker.category_status["helmet"] = "VIOLATION"
                    worker.category_conf["helmet"] = 0.0
                    missing.append("helmet")
                else:
                    worker.category_status["helmet"] = "UNKNOWN"
                    unknown.append("helmet")

        # Category 2: Safety Goggles
        if "goggles" in self.required_categories:
            if "goggles" in found_classes:
                worker.category_status["goggles"] = "COMPLIANT"
                worker.category_conf["goggles"] = found_classes["goggles"]
                compliant.append("goggles")
            elif "no_goggles" in found_classes:
                worker.category_status["goggles"] = "VIOLATION"
                worker.category_conf["goggles"] = found_classes["no_goggles"]
                missing.append("goggles")
            else:
                if w_h >= 60:
                    worker.category_status["goggles"] = "VIOLATION"
                    worker.category_conf["goggles"] = 0.0
                    missing.append("goggles")
                else:
                    worker.category_status["goggles"] = "UNKNOWN"
                    unknown.append("goggles")

        # Category 3: Protective Gloves
        if "gloves" in self.required_categories:
            if "glove" in found_classes:
                worker.category_status["gloves"] = "COMPLIANT"
                worker.category_conf["gloves"] = found_classes["glove"]
                compliant.append("gloves")
            elif "no_glove" in found_classes:
                worker.category_status["gloves"] = "VIOLATION"
                worker.category_conf["gloves"] = found_classes["no_glove"]
                missing.append("gloves")
            else:
                if w_h >= 60:
                    worker.category_status["gloves"] = "VIOLATION"
                    worker.category_conf["gloves"] = 0.0
                    missing.append("gloves")
                else:
                    worker.category_status["gloves"] = "UNKNOWN"
                    unknown.append("gloves")

        # Category 4: Protective Mask / Respirator
        if "mask" in self.required_categories:
            if "mask" in found_classes:
                worker.category_status["mask"] = "COMPLIANT"
                worker.category_conf["mask"] = found_classes["mask"]
                compliant.append("mask")
            elif "no_mask" in found_classes:
                worker.category_status["mask"] = "VIOLATION"
                worker.category_conf["mask"] = found_classes["no_mask"]
                missing.append("mask")
            else:
                if w_h >= 60:
                    worker.category_status["mask"] = "VIOLATION"
                    worker.category_conf["mask"] = 0.0
                    missing.append("mask")
                else:
                    worker.category_status["mask"] = "UNKNOWN"
                    unknown.append("mask")

        # Category 5: Protective Footwear
        if "shoes" in self.required_categories:
            if "shoes" in found_classes:
                worker.category_status["shoes"] = "COMPLIANT"
                worker.category_conf["shoes"] = found_classes["shoes"]
                compliant.append("shoes")
            elif "no_shoes" in found_classes:
                worker.category_status["shoes"] = "VIOLATION"
                worker.category_conf["shoes"] = found_classes["no_shoes"]
                missing.append("shoes")
            else:
                # Footwear is only observable if lower body is visible
                if w_h >= 180:
                    worker.category_status["shoes"] = "VIOLATION"
                    worker.category_conf["shoes"] = 0.0
                    missing.append("shoes")
                else:
                    worker.category_status["shoes"] = "UNKNOWN"
                    unknown.append("shoes")

        worker.missing_categories = missing
        worker.compliant_categories = compliant
        worker.unknown_categories = unknown

        return {
            "missing": missing,
            "compliant": compliant,
            "unknown": unknown
        }

    def _trigger_ppe_incident(self, worker: TrackedWorker, frame: np.ndarray):
        """Captures evidence snapshot, logs incident to SQLite, and broadcasts dashboard alert."""
        incident_id = f"PPE-{datetime.now().strftime('%Y%m%d%H%M%S')}-{worker.track_id}"
        missing_str = ", ".join(worker.missing_categories) or "PPE_VIOLATION"
        
        # 1. Create clean annotated evidence snapshot
        evidence_frame = frame.copy()
        wx1, wy1, wx2, wy2 = worker.bbox
        
        # Draw prominent red border around violating worker
        cv2.rectangle(evidence_frame, (wx1, wy1), (wx2, wy2), (0, 0, 235), 3)
        
        # Stamp evidence banner
        h, w = evidence_frame.shape[:2]
        cv2.rectangle(evidence_frame, (0, 0), (w, 55), (15, 23, 42), -1)
        cv2.putText(evidence_frame, f"CRITICAL PPE INCIDENT: {incident_id}", (15, 22), cv2.FONT_HERSHEY_DUPLEX, 0.65, (0, 0, 255), 2)
        cv2.putText(evidence_frame, f"Worker #{worker.track_id} | Missing: {missing_str} | Sustained Violation: {worker.violation_elapsed_sec}s", (15, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1)

        # 2. Save evidence file locally
        filename = f"incident_{incident_id}.jpg"
        filepath = EVIDENCE_DIR / filename
        cv2.imwrite(str(filepath), evidence_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        
        # Prune oldest evidence files if exceeding limit
        self._prune_evidence_storage()

        # 3. Insert incident into SQLite
        now_utc = datetime.now(timezone.utc).isoformat()
        start_utc = datetime.fromtimestamp(worker.violation_start_time or time.time(), timezone.utc).isoformat()
        
        incident_record = {
            "incident_id": incident_id,
            "track_id": worker.track_id,
            "missing_ppe": missing_str,
            "violation_start_utc": start_utc,
            "trigger_time_utc": now_utc,
            "duration_seconds": worker.violation_elapsed_sec,
            "status": "OPEN",
            "evidence_image_path": f"/api/ppe/evidence/{filename}",
            "operator_notes": f"Automatic {self.violation_threshold_sec:.0f}-second PPE violation trigger on Worker #{worker.track_id}."
        }
        
        db.insert_ppe_incident(incident_record)
        
        worker.alert_triggered = True
        worker.active_incident_id = incident_id
        worker.evidence_path = f"/api/ppe/evidence/{filename}"
        
        logger.warning(f"PPE INCIDENT TRIGGERED: {incident_id} on Worker #{worker.track_id} for {missing_str}")

        # Notify registered listeners (e.g. WebSocket clients)
        for listener in self._incident_listeners:
            try:
                listener({"type": "ppe_incident", "incident": incident_record})
            except Exception:
                pass

    def _resolve_worker_incident(self, worker: TrackedWorker):
        """Resolves an open PPE incident in SQLite when worker becomes compliant."""
        if not worker.active_incident_id:
            return
        
        incident_id = worker.active_incident_id
        now_utc = datetime.now(timezone.utc).isoformat()
        db.resolve_ppe_incident(
            incident_id=incident_id,
            resolved_time_utc=now_utc,
            notes=f"Compliance restored after {worker.violation_elapsed_sec}s violation."
        )
        logger.info(f"PPE Incident {incident_id} on Worker #{worker.track_id} resolved.")
        worker.active_incident_id = None

        # Notify registered listeners
        for listener in self._incident_listeners:
            try:
                listener({"type": "ppe_incident_resolved", "incident_id": incident_id, "track_id": worker.track_id})
            except Exception:
                pass

    def _prune_evidence_storage(self):
        """Keeps evidence directory bounded within max_evidence_files."""
        try:
            files = sorted(EVIDENCE_DIR.glob("incident_*.jpg"), key=os.path.getmtime)
            if len(files) > self.max_evidence_files:
                for f in files[:len(files) - self.max_evidence_files]:
                    try:
                        f.unlink()
                    except Exception:
                        pass
        except Exception as e:
            logger.debug(f"Evidence pruning error: {e}")

    def _draw_worker_annotations(
        self, 
        frame: np.ndarray, 
        worker: TrackedWorker, 
        compliance: Dict[str, Any],
        worker_ppe: List[Dict[str, Any]]
    ):
        """Draws clean, professional computer-vision HUD overlays on a worker."""
        x1, y1, x2, y2 = worker.bbox
        has_violation = len(compliance["missing"]) > 0

        # Choose worker box color
        box_color = (0, 0, 235) if has_violation else (34, 197, 94) # BGR: Red or Green
        cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 2)

        # Worker Label Pill
        if has_violation:
            missing_preview = ", ".join(compliance.get("missing", [])[:2])
            label = f"Worker #{worker.track_id} | Missing: {missing_preview}"
        else:
            label = f"Worker #{worker.track_id} | PPE COMPLIANT"

        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        cv2.rectangle(frame, (x1, max(0, y1 - 22)), (x1 + tw + 10, y1), box_color, -1)
        cv2.putText(frame, label, (x1 + 5, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)

        # Draw PPE item bounding boxes
        for ppe in worker_ppe:
            px1, py1, px2, py2 = ppe["bbox"]
            pcls = ppe["class"]
            pconf = ppe.get("conf", 0.0)
            is_neg = pcls.startswith("no_")
            pcolor = (0, 0, 220) if is_neg else (34, 197, 94)
            cv2.rectangle(frame, (px1, py1), (px2, py2), pcolor, 2)
            item_lbl = f"{pcls} ({int(pconf*100)}%)"
            cv2.putText(frame, item_lbl, (px1, max(14, py1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, pcolor, 1)

        # Draw 60s Violation Countdown Timer below worker box
        if has_violation and worker.violation_start_time:
            elapsed = worker.violation_elapsed_sec
            remaining = max(0.0, self.violation_threshold_sec - elapsed)
            timer_str = f"ALERT IN: {remaining:.1f}s" if remaining > 0 else "VIOLATION LOGGED"
            
            bar_w = x2 - x1
            progress_w = int(bar_w * min(1.0, elapsed / self.violation_threshold_sec))
            
            # Progress bar background
            cv2.rectangle(frame, (x1, y2 + 4), (x2, y2 + 18), (15, 23, 42), -1)
            # Progress bar fill (Amber to Red)
            bar_color = (0, 0, 235) if remaining == 0 else (0, 165, 255)
            cv2.rectangle(frame, (x1, y2 + 4), (x1 + progress_w, y2 + 18), bar_color, -1)
            cv2.putText(frame, timer_str, (x1 + 4, y2 + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)

    def _draw_hud_banner(self, frame: np.ndarray, total_workers: int, total_violations: int):
        """Draws top HUD banner with inference FPS, latency, and violation counts."""
        h, w = frame.shape[:2]
        
        # Transparent top header bar
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, 32), (2, 6, 23), -1)
        cv2.addWeighted(overlay, 0.8, frame, 0.2, 0, frame)

        status_text = f"PYROGUARD AI: {self.ai_status} | {self.actual_fps} FPS ({self.latency_ms}ms) | WORKERS: {total_workers} | VIOLATIONS: {total_violations}"
        cv2.putText(frame, status_text, (10, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (241, 245, 249), 1)

    def get_status(self) -> Dict[str, Any]:
        """Returns the current state and performance metrics of the PPE engine."""
        with self.worker_lock:
            workers_summary = []
            for tid, w in self.tracked_workers.items():
                workers_summary.append({
                    "track_id": int(tid),
                    "bbox": [int(c) for c in w.bbox],
                    "missing_categories": list(w.missing_categories),
                    "compliant_categories": list(w.compliant_categories),
                    "unknown_categories": list(w.unknown_categories),
                    "category_status": dict(w.category_status),
                    "violation_elapsed_sec": float(w.violation_elapsed_sec),
                    "violation_remaining_sec": float(max(0.0, self.violation_threshold_sec - w.violation_elapsed_sec) if len(w.missing_categories) > 0 else 0.0),
                    "alert_triggered": bool(w.alert_triggered),
                    "active_incident_id": str(w.active_incident_id) if w.active_incident_id else None,
                    "evidence_path": str(w.evidence_path) if w.evidence_path else None
                })

        return {
            "ai_status": self.ai_status,
            "target_fps": self.target_fps,
            "actual_fps": self.actual_fps,
            "latency_ms": self.latency_ms,
            "total_frames_processed": self.total_frames_processed,
            "active_workers_count": len(self.tracked_workers),
            "active_violations_count": self.active_violations_count,
            "violation_threshold_sec": self.violation_threshold_sec,
            "required_categories": self.required_categories,
            "supported_categories": ["helmet", "goggles", "gloves", "mask", "shoes"],
            "unsupported_categories": ["protective_clothing_antistatic_overalls"],
            "workers": workers_summary
        }

# Global Engine Singleton (initialized in main.py)
ppe_engine: Optional[PPEInferenceEngine] = None
