from __future__ import annotations
import os
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_dsn: str = "postgresql+asyncpg://opcua_admin:changeme@localhost:5432/opcua"
    postgres_replica_dsn: str = ""   # optional read replica
    redis_url: str = "redis://:redis_pass@localhost:6379/0"

    jwt_secret: str = "change_this"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440

    cors_origins: List[str] = ["http://localhost:3000"]
    log_level: str = "INFO"

    # OPC UA server (single-server mode reference for mgmt endpoints)
    opc_server_url: str = "opc.tcp://localhost:4840"
    opc_security_mode: str = "None"
    opc_security_policy: str = "None"

    # Feature flags (mirror client)
    feature_write: bool = True
    feature_methods: bool = True
    feature_multi_server: bool = False

    @property
    def pg_dsn_sync(self) -> str:
        return self.postgres_dsn.replace("postgresql+asyncpg://", "postgresql://")

    @property
    def pg_replica_dsn_sync(self) -> str:
        dsn = self.postgres_replica_dsn or self.postgres_dsn
        return dsn.replace("postgresql+asyncpg://", "postgresql://")


settings = Settings()
