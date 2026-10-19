"""Runtime configuration with validation.

Only the backend service receives DATABASE_URL; migration/test URLs are for
the tools service. Frontend receives no secrets (see compose.yaml).
"""

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str = Field(alias="DATABASE_URL")
    allowed_origins: str = Field(default="http://localhost:3000", alias="ALLOWED_ORIGINS")
    db_pool_size: int = Field(default=5, alias="DB_POOL_SIZE")
    db_connect_timeout: int = Field(default=3, alias="DB_CONNECT_TIMEOUT")

    # In-process failed-login throttling (bucket = client address + email).
    login_rate_limit_attempts: int = Field(default=5, alias="LOGIN_RATE_LIMIT_ATTEMPTS")
    login_rate_limit_window_seconds: int = Field(
        default=60, alias="LOGIN_RATE_LIMIT_WINDOW_SECONDS"
    )

    # Expected Alembic head revision for readiness. When set, /health
    # requires an exact match; when unset, any stored revision suffices.
    # The deployment sets this to the current Alembic head (see .env.example).
    expected_alembic_revision: str | None = Field(
        default=None, alias="EXPECTED_ALEMBIC_REVISION"
    )

    @field_validator("database_url")
    @classmethod
    def _require_psycopg_scheme(cls, v: str) -> str:
        if not v.startswith("postgresql+psycopg://"):
            raise ValueError("DATABASE_URL must use postgresql+psycopg:// scheme")
        if "@localhost" in v or "@127.0.0.1" in v:
            # Inside Compose, Postgres is reachable as db:5432, not localhost.
            raise ValueError("DATABASE_URL must use db:5432 host inside Compose")
        return v

    @field_validator("expected_alembic_revision", mode="before")
    @classmethod
    def _empty_revision_is_unset(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("db_pool_size")
    @classmethod
    def _bound_pool(cls, v: int) -> int:
        if not 1 <= v <= 10:
            raise ValueError("DB_POOL_SIZE must be 1..10")
        return v

    @field_validator("login_rate_limit_attempts")
    @classmethod
    def _bound_login_attempts(cls, v: int) -> int:
        if not 1 <= v <= 1000:
            raise ValueError("LOGIN_RATE_LIMIT_ATTEMPTS must be 1..1000")
        return v

    @field_validator("login_rate_limit_window_seconds")
    @classmethod
    def _bound_login_window(cls, v: int) -> int:
        if not 1 <= v <= 86_400:
            raise ValueError("LOGIN_RATE_LIMIT_WINDOW_SECONDS must be 1..86400")
        return v

    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
