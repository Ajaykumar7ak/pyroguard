import json
import os
from pathlib import Path
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field

CONFIG_FILE_PATH = Path(__file__).resolve().parent / "settings.json"
ENV_FILE_PATH = Path(__file__).resolve().parent / ".env"

DEFAULT_SETTINGS = {
    "sensor_baud_rate": 115200,
    "sensor_com_port": "COM4",
    "sensor_connection_mode": "python_collector",
    "camera_ip": "10.131.84.41",
    "camera_stream_url": "http://10.131.84.41:81/stream",
    "camera_stream_mode": "proxy", # "proxy" (MJPEG), "snapshot_refresh", or "direct"
    "dht_high_temp_threshold": 50.0,
    "flame_alert_enabled": True
}

class AppSettings(BaseModel):
    sensor_baud_rate: int = Field(default=115200, description="Serial baud rate matching ESP32 firmware")
    sensor_com_port: str = Field(default="COM4", description="Configured COM port (e.g. COM4)")
    sensor_connection_mode: str = Field(default="python_collector", description="Connection mode")
    camera_ip: str = Field(default="10.131.84.41", description="Local IPv4 of ESP32-CAM")
    camera_stream_url: str = Field(default="http://10.131.84.41:81/stream", description="Stream endpoint URL")
    camera_stream_mode: str = Field(default="proxy", description="proxy (backend stream bridge), snapshot_refresh, or direct")
    dht_high_temp_threshold: float = Field(default=50.0)
    flame_alert_enabled: bool = Field(default=True)

class CloudConfig(BaseModel):
    enabled: bool = Field(default=False, description="Whether cloud synchronization is active")
    provider: str = Field(default="supabase", description="Cloud provider (supabase)")
    supabase_url: Optional[str] = Field(default=None, description="Supabase project URL")
    supabase_key: Optional[str] = Field(default=None, description="Privileged service-role key for backend synchronization")
    sync_interval_seconds: int = Field(default=30, description="Interval between sync worker cycles")
    batch_size: int = Field(default=50, description="Max records uploaded per batch")
    max_retries: int = Field(default=5, description="Max retries before extended backoff")

def load_dotenv_file(filepath: Optional[Path] = None):
    """
    Lightweight zero-dependency .env loader.
    Searches candidate paths (explicit path, backend/.env, root .env, cwd/.env)
    and reads key-value pairs into os.environ without overwriting pre-existing env vars.
    """
    candidates = []
    if filepath:
        candidates.append(Path(filepath))
    candidates.append(Path(__file__).resolve().parent / ".env")
    candidates.append(Path(__file__).resolve().parent.parent / ".env")
    candidates.append(Path.cwd() / ".env")

    for target in candidates:
        if target.is_file():
            try:
                with open(target, "r", encoding="utf-8") as f:
                    for line in f:
                        stripped = line.strip()
                        if not stripped or stripped.startswith("#"):
                            continue
                        if "=" in stripped:
                            key, val = stripped.split("=", 1)
                            key = key.strip()
                            val = val.strip().strip("'\"")
                            if key and key not in os.environ:
                                os.environ[key] = val
                break
            except Exception as e:
                pass

# Initial load of .env on import
load_dotenv_file()

def load_settings() -> AppSettings:
    if not CONFIG_FILE_PATH.exists():
        save_settings(AppSettings())
        return AppSettings()
    try:
        with open(CONFIG_FILE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return AppSettings(**data)
    except Exception as e:
        print(f"[CONFIG] Error loading settings from {CONFIG_FILE_PATH}: {e}. Using defaults.")
        return AppSettings()

def save_settings(settings: AppSettings) -> AppSettings:
    try:
        with open(CONFIG_FILE_PATH, "w", encoding="utf-8") as f:
            f.write(settings.model_dump_json(indent=2))
        return settings
    except Exception as e:
        print(f"[CONFIG] Error saving settings: {e}")
        return settings

def reset_settings() -> AppSettings:
    defaults = AppSettings(**DEFAULT_SETTINGS)
    return save_settings(defaults)

def load_cloud_config() -> CloudConfig:
    """Loads cloud configuration from environment variables (including those from .env)."""
    load_dotenv_file()
    
    url = os.getenv("SUPABASE_URL", "").strip() or os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").strip() or None
    # Support SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY, and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    key = (
        os.getenv("SUPABASE_SECRET_KEY", "").strip()
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.getenv("SUPABASE_KEY", "").strip()
        or os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "").strip()
        or os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip()
        or None
    )
    
    # Enabled if explicitly set or if valid URL and key exist and not explicitly disabled
    enabled_str = os.getenv("CLOUD_SYNC_ENABLED", "").lower().strip()
    if enabled_str in ["true", "1", "yes"]:
        enabled = True
    elif enabled_str in ["false", "0", "no"]:
        enabled = False
    else:
        enabled = bool(url and key)

    provider = os.getenv("CLOUD_PROVIDER", "supabase").strip() or "supabase"
    
    try:
        interval = int(os.getenv("CLOUD_SYNC_INTERVAL_SECONDS", "30"))
    except ValueError:
        interval = 30

    try:
        batch_size = int(os.getenv("CLOUD_SYNC_BATCH_SIZE", "50"))
    except ValueError:
        batch_size = 50

    try:
        max_retries = int(os.getenv("CLOUD_SYNC_MAX_RETRIES", "5"))
    except ValueError:
        max_retries = 5

    return CloudConfig(
        enabled=enabled,
        provider=provider,
        supabase_url=url,
        supabase_key=key,
        sync_interval_seconds=interval,
        batch_size=batch_size,
        max_retries=max_retries
    )

def get_safe_cloud_config() -> Dict[str, Any]:
    """Returns cloud status metadata for API and UI without revealing secret keys."""
    cfg = load_cloud_config()
    is_configured = bool(cfg.supabase_url and cfg.supabase_key and not cfg.supabase_url.startswith("https://your-project"))
    masked_key = None
    if cfg.supabase_key:
        if len(cfg.supabase_key) > 8:
            masked_key = f"{cfg.supabase_key[:4]}...{cfg.supabase_key[-4:]}"
        else:
            masked_key = "****"

    return {
        "is_configured": is_configured,
        "enabled": cfg.enabled and is_configured,
        "provider": cfg.provider,
        "supabase_url": cfg.supabase_url if is_configured else None,
        "masked_key": masked_key if is_configured else None,
        "sync_interval_seconds": cfg.sync_interval_seconds,
        "batch_size": cfg.batch_size,
        "max_retries": cfg.max_retries
    }
