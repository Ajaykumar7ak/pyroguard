import abc
import logging
from typing import Dict, Any, List, Optional, Tuple
import httpx
from config import CloudConfig, load_cloud_config

logger = logging.getLogger("pyroguard.cloud_provider")

async def check_internet_connectivity(timeout_seconds: float = 2.0) -> bool:
    """
    Probes reliable public endpoints to test general host internet reachability.
    Uses fast lightweight HEAD/GET requests with a short timeout.
    """
    cfg = load_cloud_config()
    test_endpoints = [
        "https://1.1.1.1",
        "https://www.google.com/generate_204",
        "https://8.8.8.8"
    ]
    if cfg.supabase_url and not cfg.supabase_url.startswith("https://your-project"):
        test_endpoints.insert(0, cfg.supabase_url)

    for url in test_endpoints:
        try:
            async with httpx.AsyncClient(timeout=timeout_seconds, verify=False) as client:
                resp = await client.head(url)
                if resp.status_code in [200, 204, 301, 302, 401, 403]:
                    return True
        except Exception:
            continue
    return False

class CloudSyncProvider(abc.ABC):
    """
    Abstract interface for cloud backup synchronization providers.
    Ensures backend ingestion logic remains decoupled from specific cloud implementations.
    """
    @abc.abstractmethod
    async def check_health(self) -> Dict[str, Any]:
        """Verify reachability and authentication with the cloud backend."""
        pass

    @abc.abstractmethod
    async def upload_sensor_readings(
        self, readings: List[Dict[str, Any]]
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Uploads a batch of sensor readings.
        Returns: (successful_reading_ids, list_of_failed_records_with_errors)
        """
        pass

    @abc.abstractmethod
    async def upload_alarm_events(
        self, events: List[Dict[str, Any]]
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Uploads a batch of alarm events.
        Returns: (successful_event_ids, list_of_failed_records_with_errors)
        """
        pass

    @abc.abstractmethod
    async def upload_devices(
        self, devices: List[Dict[str, Any]]
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Uploads device registry records."""
        pass

class SupabaseSyncProvider(CloudSyncProvider):
    """
    PostgREST / Supabase cloud provider implementation.
    Performs idempotent batch upserts using 'resolution=merge-duplicates' so duplicate
    packets or retried batches never create duplicate cloud rows.
    """
    def __init__(self, config: Optional[CloudConfig] = None):
        self.config = config or load_cloud_config()

    def _get_headers(self) -> Dict[str, str]:
        key = self.config.supabase_key or ""
        return {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"
        }

    def is_configured(self) -> bool:
        url = self.config.supabase_url
        key = self.config.supabase_key
        if not url or not key:
            return False
        if "your-project" in url or "your_supabase" in key:
            return False
        return True

    async def check_health(self) -> Dict[str, Any]:
        """
        Distinguishes:
          - NOT_CONFIGURED
          - INTERNET_UNAVAILABLE
          - AUTH_FAILURE (HTTP 401/403)
          - SERVICE_UNAVAILABLE (HTTP 5xx / DNS / ConnectError)
          - ONLINE (HTTP 200)
        """
        if not self.is_configured():
            return {
                "status": "NOT_CONFIGURED",
                "is_online": False,
                "message": "Cloud backup not configured. Operator must supply SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
            }

        # First check internet reachability
        has_internet = await check_internet_connectivity()
        if not has_internet:
            return {
                "status": "INTERNET_UNAVAILABLE",
                "is_online": False,
                "message": "Host internet connection is unreachable."
            }

        # Probe Supabase PostgREST root
        base_url = self.config.supabase_url.rstrip("/")
        test_url = f"{base_url}/rest/v1/"

        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.get(test_url, headers=self._get_headers())
                if resp.status_code == 200:
                    return {
                        "status": "ONLINE",
                        "is_online": True,
                        "message": "Supabase cloud service connected and authenticated."
                    }
                elif resp.status_code in [401, 403]:
                    key = self.config.supabase_key or ""
                    if "Secret API key required" in resp.text or key.startswith("sb_publishable_"):
                        # Check if schema tables are created
                        try:
                            schema_resp = await client.get(f"{base_url}/rest/v1/sensor_readings?limit=1", headers=self._get_headers())
                            if schema_resp.status_code == 404 and "PGRST205" in schema_resp.text:
                                return {
                                    "status": "SCHEMA_MISSING",
                                    "is_online": False,
                                    "message": "Supabase reached, but tables (sensor_readings, alarm_events) are not created yet. Run the SQL migration in Supabase SQL Editor. Also ensure SUPABASE_SERVICE_ROLE_KEY is used for backend syncing."
                                }
                        except Exception:
                            pass
                        return {
                            "status": "AUTH_FAILURE",
                            "is_online": False,
                            "message": "Supabase publishable key provided. Supabase requires the secret service_role key for backend synchronization (Project Settings -> API)."
                        }
                    return {
                        "status": "AUTH_FAILURE",
                        "is_online": False,
                        "message": f"Authentication failed with Supabase (HTTP {resp.status_code}). Check service role key."
                    }
                else:
                    return {
                        "status": "SERVICE_UNAVAILABLE",
                        "is_online": False,
                        "message": f"Supabase service returned HTTP {resp.status_code}: {resp.text[:100]}"
                    }
        except (httpx.ConnectError, httpx.ConnectTimeout) as ce:
            return {
                "status": "SERVICE_UNAVAILABLE",
                "is_online": False,
                "message": f"Could not establish connection to {base_url}: {ce}"
            }
        except Exception as e:
            return {
                "status": "ERROR",
                "is_online": False,
                "message": f"Cloud health check exception: {e}"
            }

    async def upload_sensor_readings(
        self, readings: List[Dict[str, Any]]
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Uploads batch of sensor readings to Supabase 'sensor_readings' table.
        Uses PostgREST upsert (on conflict on reading_id DO UPDATE).
        """
        if not self.is_configured() or not readings:
            return [], [{"error": "Cloud not configured", "items": readings}]

        base_url = self.config.supabase_url.rstrip("/")
        endpoint = f"{base_url}/rest/v1/sensor_readings"

        # Deduplicate within batch by reading_id (keeping the latest occurrence)
        dedup_readings = {}
        for r in readings:
            rid = r.get("reading_id")
            if rid:
                dedup_readings[rid] = r

        clean_rows = []
        id_map = {}
        for rid, r in dedup_readings.items():
            clean_row = {
                "reading_id": rid,
                "device_id": r.get("device_id", "PYRO-ESP32"),
                "timestamp_utc": r.get("timestamp_utc"),
                "uptime_ms": r.get("uptime_ms"),
                "temperature_c": r.get("temperature_c"),
                "humidity_pct": r.get("humidity_pct"),
                "flame_detected": bool(r.get("flame_detected")),
                "buzzer_on": bool(r.get("buzzer_on")),
                "source": r.get("source", "serial"),
                "validation_status": r.get("validation_status", "VALID")
            }
            if r.get("synced_at_utc"):
                clean_row["synced_at_utc"] = r["synced_at_utc"]
            clean_rows.append(clean_row)
            id_map[rid] = r

        if not clean_rows:
            return [], []

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(endpoint, json=clean_rows, headers=self._get_headers())
                if resp.status_code in [200, 201, 204]:
                    success_ids = [row["reading_id"] for row in clean_rows]
                    return success_ids, []
                else:
                    err_msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
                    logger.warning(f"Failed to upload readings batch: {err_msg}")
                    failed = [{"reading_id": r["reading_id"], "error": err_msg} for r in clean_rows]
                    return [], failed
        except Exception as e:
            err_msg = str(e)
            logger.error(f"Upload exception for sensor readings: {err_msg}")
            failed = [{"reading_id": r["reading_id"], "error": err_msg} for r in clean_rows]
            return [], failed

    async def upload_alarm_events(
        self, events: List[Dict[str, Any]]
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Uploads batch of alarm events to Supabase 'alarm_events' table.
        Uses PostgREST upsert (on conflict on event_id DO UPDATE).
        """
        if not self.is_configured() or not events:
            return [], [{"error": "Cloud not configured", "items": events}]

        base_url = self.config.supabase_url.rstrip("/")
        endpoint = f"{base_url}/rest/v1/alarm_events"

        # Deduplicate within batch by event_id (keeping the latest occurrence)
        dedup_events = {}
        for e in events:
            eid = e.get("event_id")
            if eid:
                dedup_events[eid] = e

        clean_rows = []
        for eid, e in dedup_events.items():
            clean_row = {
                "event_id": eid,
                "device_id": e.get("device_id", "PYRO-ESP32"),
                "event_type": e.get("event_type", "FLAME_HAZARD"),
                "severity": e.get("severity", "CRITICAL"),
                "source": e.get("source", "hardware_sensor"),
                "start_time_utc": e.get("start_time_utc") or datetime.now(timezone.utc).isoformat(),
                "end_time_utc": e.get("end_time_utc"),
                "is_active": bool(e.get("is_active", True)),
                "is_acknowledged": bool(e.get("is_acknowledged", False)),
                "acknowledged_at_utc": e.get("acknowledged_at_utc"),
                "operator_notes": e.get("operator_notes")
            }
            if e.get("synced_at_utc"):
                clean_row["synced_at_utc"] = e["synced_at_utc"]
            clean_rows.append(clean_row)

        if not clean_rows:
            return [], []

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(endpoint, json=clean_rows, headers=self._get_headers())
                if resp.status_code in [200, 201, 204]:
                    success_ids = [row["event_id"] for row in clean_rows]
                    return success_ids, []
                else:
                    err_msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
                    failed = [{"event_id": row["event_id"], "error": err_msg} for row in clean_rows]
                    return [], failed
        except Exception as e:
            err_msg = str(e)
            failed = [{"event_id": row["event_id"], "error": err_msg} for row in clean_rows]
            return [], failed

    async def upload_devices(
        self, devices: List[Dict[str, Any]]
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Uploads device registry to Supabase 'devices' table."""
        if not self.is_configured() or not devices:
            return [], []

        base_url = self.config.supabase_url.rstrip("/")
        endpoint = f"{base_url}/rest/v1/devices"

        clean_rows = []
        for d in devices:
            did = d.get("device_id")
            if not did:
                continue
            clean_rows.append({
                "device_id": did,
                "device_type": d.get("device_type", "ESP32_SENSOR_NODE"),
                "connection_status": d.get("connection_status", "CONNECTED"),
                "last_reading_utc": d.get("last_reading_utc"),
                "last_seen_utc": d.get("last_seen_utc"),
                "diagnostics": d.get("diagnostics") if isinstance(d.get("diagnostics"), str) else None
            })

        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(endpoint, json=clean_rows, headers=self._get_headers())
                if resp.status_code in [200, 201, 204]:
                    return [row["device_id"] for row in clean_rows], []
                else:
                    return [], [{"error": f"HTTP {resp.status_code}"}]
        except Exception as e:
            return [], [{"error": str(e)}]
