"""
Configuration management for the OPC UA client.
All settings read from environment variables or .env file.
"""
from __future__ import annotations
from typing import List, Optional
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── OPC UA Server ────────────────────────────
    opc_server_url: str = "opc.tcp://localhost:4840"
    opc_security_mode: str = "None"          # None | Sign | SignAndEncrypt
    opc_security_policy: str = "None"        # None | Basic256Sha256 | Aes128Sha256RsaOaep
    opc_username: Optional[str] = None
    opc_password: Optional[str] = None
    opc_application_uri: str = "urn:opcua-platform:client"
    opc_certificate_path: str = "/app/certs/client_cert.pem"
    opc_private_key_path: str = "/app/certs/client_key.pem"

    # ── Subscription ────────────────────────────
    publish_interval_ms: int = 1000
    max_keepalive_count: int = 10
    max_notifications_per_publish: int = 1000
    requested_lifetime_count: int = 100
    reconnect_delay_s: float = 5.0
    max_reconnect_attempts: int = 0          # 0 = infinite

    # ── Persistence ─────────────────────────────
    postgres_dsn: str = "postgresql+asyncpg://opcua_admin:changeme@localhost:5432/opcua"
    batch_insert_size: int = 500
    buffer_flush_interval_s: float = 5.0
    local_buffer_path: str = "/app/buffer/offline.db"  # SQLite fallback

    # ── Redis ───────────────────────────────────
    redis_url: str = "redis://:redis_pass@localhost:6379/0"
    redis_tag_ttl_s: int = 300              # live value TTL in cache

    # ── Alarm evaluation ────────────────────────
    alarm_eval_interval_s: float = 1.0

    # ── Observability ───────────────────────────
    log_level: str = "INFO"
    metrics_port: int = 9090

    # ── Tag config file (YAML) ──────────────────
    tag_config_path: str = "/app/config/tags.yaml"

    @field_validator("opc_security_mode")
    @classmethod
    def validate_security_mode(cls, v: str) -> str:
        allowed = {"None", "Sign", "SignAndEncrypt"}
        if v not in allowed:
            raise ValueError(f"opc_security_mode must be one of {allowed}")
        return v


settings = Settings()
