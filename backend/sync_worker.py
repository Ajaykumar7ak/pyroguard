import asyncio
import logging
import json
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
from pathlib import Path

import db
from config import CloudConfig, load_cloud_config, get_safe_cloud_config
from cloud_provider import CloudSyncProvider, SupabaseSyncProvider, check_internet_connectivity

logger = logging.getLogger("pyroguard.sync_worker")

class SyncWorker:
    """
    30-Second Background Cloud Backup & Synchronization Worker.
    Runs non-blocking async cycles, handles exponential backoff, partial batch failures,
    and manual trigger requests without impacting local sensor collection.
    """
    def __init__(
        self, 
        provider: Optional[CloudSyncProvider] = None, 
        db_path: Optional[Path] = None,
        interval_seconds: Optional[int] = None
    ):
        self.db_path = db_path
        self.provider = provider or SupabaseSyncProvider()
        self.interval_seconds = interval_seconds or 30

        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._lock = asyncio.Lock()

        # Operational status tracking
        self.is_syncing = False
        self.last_sync_utc: Optional[str] = None
        self.last_attempt_utc: Optional[str] = None
        self.next_scheduled_utc: Optional[str] = None
        self.last_error: Optional[str] = None
        self.last_status: str = "IDLE"
        self.last_result: Dict[str, Any] = {
            "synced_count": 0,
            "failed_count": 0,
            "status": "INITIALIZING"
        }

    def start(self):
        """Starts the background 30-second synchronization loop in the current asyncio event loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._worker_loop(), name="CloudSyncWorkerTask")
        logger.info(f"Cloud sync worker started (Interval: {self.interval_seconds}s)")

    def stop(self):
        """Cancels and stops the background sync worker task."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        logger.info("Cloud sync worker stopped")

    async def _worker_loop(self):
        """Background loop executing sync cycle every 30 seconds."""
        while self._running:
            try:
                now_dt = datetime.now(timezone.utc)
                self.next_scheduled_utc = (now_dt + timedelta(seconds=self.interval_seconds)).isoformat()
                
                # Execute sync cycle
                await self.sync_once()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Unexpected error in sync worker loop: {e}")
                self.last_error = str(e)
                self.last_status = "ERROR"

            # Sleep until next scheduled cycle
            try:
                await asyncio.sleep(self.interval_seconds)
            except asyncio.CancelledError:
                break

    async def sync_once(self, force: bool = False) -> Dict[str, Any]:
        """
        Executes a single bounded batch synchronization pass.
        Safe for concurrent invocation (e.g. manual Sync Now button).
        """
        async with self._lock:
            self.is_syncing = True
            now_dt = datetime.now(timezone.utc)
            now_iso = now_dt.isoformat()
            self.last_attempt_utc = now_iso

            result = {
                "timestamp_utc": now_iso,
                "status": "PENDING",
                "synced_count": 0,
                "failed_count": 0,
                "provider": "supabase",
                "message": ""
            }

            try:
                # 1. Probe cloud provider health and connectivity
                health = await self.provider.check_health()
                provider_status = health.get("status", "UNKNOWN")

                if provider_status == "NOT_CONFIGURED":
                    self.last_status = "NOT_CONFIGURED"
                    self.last_error = None
                    result["status"] = "NOT_CONFIGURED"
                    result["message"] = health.get("message", "Cloud backup credentials not configured.")
                    self.last_result = result
                    return result

                if provider_status == "INTERNET_UNAVAILABLE":
                    self.last_status = "INTERNET_UNAVAILABLE"
                    self.last_error = "Host internet connection is unreachable."
                    result["status"] = "INTERNET_UNAVAILABLE"
                    result["message"] = "Internet unavailable; retaining pending records locally in SQLite."
                    self.last_result = result
                    return result

                if provider_status == "AUTH_FAILURE":
                    self.last_status = "AUTH_FAILURE"
                    self.last_error = health.get("message", "Cloud authentication failure.")
                    result["status"] = "AUTH_FAILURE"
                    result["message"] = self.last_error
                    self.last_result = result
                    return result

                if provider_status != "ONLINE" and not health.get("is_online"):
                    self.last_status = "SERVICE_UNAVAILABLE"
                    self.last_error = health.get("message", "Cloud service is currently unreachable.")
                    result["status"] = "SERVICE_UNAVAILABLE"
                    result["message"] = self.last_error
                    self.last_result = result
                    return result

                # 2. Select eligible pending records from local sync_queue
                cfg = load_cloud_config()
                batch_size = cfg.batch_size
                pending_records = db.get_pending_sync_records(limit=batch_size, db_path=self.db_path)

                if not pending_records:
                    self.last_status = "ONLINE_IDLE"
                    self.last_error = None
                    result["status"] = "SUCCESS"
                    result["message"] = "Sync queue is clean. Zero pending records."
                    self.last_result = result
                    return result

                # 3. Categorize records by type (sensor_readings, alarm_events)
                readings_queue: List[Dict[str, Any]] = []
                alarms_queue: List[Dict[str, Any]] = []

                for rec in pending_records:
                    rtype = rec.get("record_type")
                    payload = rec.get("payload", {})
                    # Ensure reference ID matches payload
                    if rtype == "sensor_reading":
                        payload["reading_id"] = rec["payload_reference"]
                        payload["_queue_id"] = rec["queue_id"]
                        payload["_attempt"] = rec.get("attempt_count", 0)
                        readings_queue.append(payload)
                    elif rtype == "alarm_event":
                        full_alarm = db.get_alarm_event_by_id(rec["payload_reference"], db_path=self.db_path)
                        if full_alarm:
                            payload = {**full_alarm, **payload}
                        payload["event_id"] = rec["payload_reference"]
                        payload["_queue_id"] = rec["queue_id"]
                        payload["_attempt"] = rec.get("attempt_count", 0)
                        alarms_queue.append(payload)

                synced_queue_ids: List[str] = []
                failed_items: List[Dict[str, Any]] = []

                # 4. Upload sensor readings batch
                if readings_queue:
                    success_ids, failed_r = await self.provider.upload_sensor_readings(readings_queue)
                    for item in readings_queue:
                        if item["reading_id"] in success_ids:
                            synced_queue_ids.append(item["_queue_id"])
                        else:
                            err_info = next((f["error"] for f in failed_r if f.get("reading_id") == item["reading_id"]), "Upload failed")
                            failed_items.append({"queue_id": item["_queue_id"], "attempt": item["_attempt"], "error": err_info})

                # 5. Upload alarm events batch
                if alarms_queue:
                    success_eids, failed_a = await self.provider.upload_alarm_events(alarms_queue)
                    for item in alarms_queue:
                        if item["event_id"] in success_eids:
                            synced_queue_ids.append(item["_queue_id"])
                        else:
                            err_info = next((f["error"] for f in failed_a if f.get("event_id") == item["event_id"]), "Upload failed")
                            failed_items.append({"queue_id": item["_queue_id"], "attempt": item["_attempt"], "error": err_info})

                # 6. Mark successful records SYNCED in local SQLite
                if synced_queue_ids:
                    db.mark_sync_records_success(synced_queue_ids, db_path=self.db_path)
                    result["synced_count"] = len(synced_queue_ids)
                    self.last_sync_utc = now_iso

                # 7. Mark failed records with exponential backoff
                if failed_items:
                    result["failed_count"] = len(failed_items)
                    for f in failed_items:
                        attempt = f["attempt"] + 1
                        # Backoff formula: min(300s, 30s * 2^(attempt-1))
                        backoff_sec = min(300, 30 * (2 ** min(attempt - 1, 4)))
                        next_retry = (now_dt + timedelta(seconds=backoff_sec)).isoformat()
                        db.mark_sync_record_failed(
                            queue_id=f["queue_id"],
                            error_message=f["error"],
                            next_retry_at_utc=next_retry,
                            db_path=self.db_path
                        )

                # 8. Set final cycle status
                if failed_items and not synced_queue_ids:
                    self.last_status = "BATCH_FAILED"
                    self.last_error = failed_items[0]["error"]
                    result["status"] = "ERROR"
                    result["message"] = f"Failed to upload {len(failed_items)} records: {self.last_error}"
                elif failed_items and synced_queue_ids:
                    self.last_status = "PARTIAL_SUCCESS"
                    self.last_error = f"{len(failed_items)} records failed in batch"
                    result["status"] = "PARTIAL"
                    result["message"] = f"Uploaded {len(synced_queue_ids)} records, {len(failed_items)} failed."
                else:
                    self.last_status = "SYNCED"
                    self.last_error = None
                    result["status"] = "SUCCESS"
                    result["message"] = f"Successfully uploaded {len(synced_queue_ids)} records."

            except Exception as e:
                logger.error(f"Sync execution error: {e}")
                self.last_status = "ERROR"
                self.last_error = str(e)
                result["status"] = "ERROR"
                result["message"] = str(e)
            finally:
                self.is_syncing = False
                self.last_result = result

            return result

    async def get_status(self) -> Dict[str, Any]:
        """Returns comprehensive real-time status of the cloud synchronization engine."""
        cfg_safe = get_safe_cloud_config()
        queue_summary = db.get_sync_queue_summary(db_path=self.db_path)
        internet_online = await check_internet_connectivity(timeout_seconds=1.5)

        return {
            "status": self.last_status,
            "is_syncing": self.is_syncing,
            "internet_available": internet_online,
            "cloud_configured": cfg_safe["is_configured"],
            "cloud_enabled": cfg_safe["enabled"],
            "provider": cfg_safe["provider"],
            "supabase_url": cfg_safe["supabase_url"],
            "masked_key": cfg_safe["masked_key"],
            "sync_interval_seconds": self.interval_seconds,
            "last_sync_utc": self.last_sync_utc,
            "last_attempt_utc": self.last_attempt_utc,
            "next_scheduled_utc": self.next_scheduled_utc,
            "last_error": self.last_error,
            "queue": {
                "total": queue_summary["total"],
                "pending": queue_summary["pending"],
                "failed": queue_summary["failed"],
                "synced": queue_summary["synced"],
                "oldest_pending_utc": queue_summary["oldest_pending_utc"]
            },
            "last_result": self.last_result,
            "local_first_safe": True
        }

# Global singleton sync worker instance
sync_worker = SyncWorker()
