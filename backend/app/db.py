"""Database engine construction and caching.

Synchronous SQLAlchemy + psycopg. Bounded pool (size 5, no overflow) per
TECHNICAL_DESIGN.md. No schema mutation on import or startup.

Engines are cached per connection configuration. Different DATABASE_URL or
pool settings must never reuse another configuration's engine: test,
migration, and runtime URLs stay isolated even in the same process.
"""

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from .config import Settings

_engines: dict[tuple[str, int, int], Engine] = {}


def _cache_key(settings: Settings) -> tuple[str, int, int]:
    return (
        settings.database_url,
        settings.db_pool_size,
        settings.db_connect_timeout,
    )


def engine_from_url(url: str, pool_size: int = 5, connect_timeout: int = 3) -> Engine:
    """Build a bounded-pool engine for one URL (shared construction site)."""
    return create_engine(
        url,
        pool_size=pool_size,
        max_overflow=0,
        pool_pre_ping=True,
        connect_args={"connect_timeout": connect_timeout},
    )


def get_engine(settings: Settings) -> Engine:
    """Return the cached engine for this exact configuration."""
    key = _cache_key(settings)
    engine = _engines.get(key)
    if engine is None:
        engine = engine_from_url(
            settings.database_url,
            pool_size=settings.db_pool_size,
            connect_timeout=settings.db_connect_timeout,
        )
        _engines[key] = engine
    return engine


def clear_engine_cache() -> None:
    """Dispose cached engines and clear the registry (tests only)."""
    for engine in _engines.values():
        try:
            engine.dispose()
        except Exception:
            pass
    _engines.clear()
