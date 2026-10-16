"""Regression: engine cache isolation per configuration.

Previously get_engine() cached a single global engine, so a test
configuration could receive the development engine. Engines must be keyed
by (DATABASE_URL, pool size, connect timeout). No test below opens a real
database connection; create_engine() is lazy.
"""

from app import db
from app.config import Settings


def _settings(url: str, pool: int = 5, timeout: int = 3) -> Settings:
    return Settings(
        DATABASE_URL=url,
        ALLOWED_ORIGINS="http://localhost:3000",
        DB_POOL_SIZE=pool,
        DB_CONNECT_TIMEOUT=timeout,
    )


DEV_URL = "postgresql+psycopg://dev_user:pw@db:5432/eventbook_dev"
TEST_URL = "postgresql+psycopg://test_user:pw@db:5432/eventbook_test"


def setup_function(_func) -> None:
    db.clear_engine_cache()


def teardown_function(_func) -> None:
    db.clear_engine_cache()


def test_same_config_reuses_engine() -> None:
    first = db.get_engine(_settings(DEV_URL))
    second = db.get_engine(_settings(DEV_URL))
    assert first is second


def test_different_database_url_gets_different_engine() -> None:
    dev_engine = db.get_engine(_settings(DEV_URL))
    test_engine = db.get_engine(_settings(TEST_URL))
    assert dev_engine is not test_engine
    # Re-requesting preserves each mapping; no cross-contamination.
    assert db.get_engine(_settings(DEV_URL)) is dev_engine
    assert db.get_engine(_settings(TEST_URL)) is test_engine


def test_different_pool_settings_isolate() -> None:
    default = db.get_engine(_settings(DEV_URL, pool=5))
    other_pool = db.get_engine(_settings(DEV_URL, pool=3))
    assert default is not other_pool


def test_clear_engine_cache_resets() -> None:
    first = db.get_engine(_settings(DEV_URL))
    db.clear_engine_cache()
    second = db.get_engine(_settings(DEV_URL))
    assert first is not second
