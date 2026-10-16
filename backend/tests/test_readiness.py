"""Regression: readiness requires schema + tables + migration revision.

Uses fake engines (no database connection). Proves missing or incomplete
schema yields not-ready so /health returns sanitized 503, and that revision
mismatch is also not-ready. Schema creation stays in TASK-002.

The fakes simulate PostgreSQL aborted-transaction semantics: once a query
fails, every later query on the same connection fails with
"current transaction is aborted". Readiness must therefore check
alembic_version existence via information_schema before SELECTing the
version row, never try/except around a missing-table SELECT with a
fallback query on the same connection.
"""

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.readiness import EXPECTED_TABLES, get_readiness


class _Scalars:
    def __init__(self, values):
        self._values = values

    def all(self):
        return list(self._values)


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _ScalarsResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return _Scalars(self._values)


class _FakeConn:
    """Simulates PG: a failed query aborts the transaction for later queries."""

    def __init__(self, schema, eventbook_tables, version_rows, fail_on=None):
        # version_rows maps schema -> list of version strings for schemas
        # where the table exists. Absent key means the table is missing.
        self._schema = schema
        self._eventbook_tables = eventbook_tables
        self._version_rows = dict(version_rows)
        self._fail_on = fail_on or set()
        self._aborted = False
        self.query_log: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    @property
    def aborted(self) -> bool:
        return self._aborted

    def _fail(self, message: str) -> RuntimeError:
        self._aborted = True
        return RuntimeError(message)

    def execute(self, stmt):
        sql = str(stmt)
        self.query_log.append(sql)
        if self._aborted:
            raise RuntimeError("current transaction is aborted")
        if "information_schema.schemata" in sql:
            if "schemata" in self._fail_on:
                raise self._fail("schemata query failed")
            return _ScalarResult(self._schema)
        if "table_name = 'alembic_version'" in sql:
            present = sorted(s for s in ("eventbook", "public") if s in self._version_rows)
            return _ScalarsResult(present)
        if "information_schema.tables" in sql:
            return _ScalarsResult(self._eventbook_tables)
        if "FROM eventbook.alembic_version" in sql:
            if "eventbook" not in self._version_rows:
                raise self._fail('relation "eventbook.alembic_version" does not exist')
            if "version_select" in self._fail_on:
                raise self._fail("version select failed")
            return _ScalarsResult(self._version_rows["eventbook"])
        if "FROM public.alembic_version" in sql:
            if "public" not in self._version_rows:
                raise self._fail('relation "public.alembic_version" does not exist')
            if "version_select" in self._fail_on:
                raise self._fail("version select failed")
            return _ScalarsResult(self._version_rows["public"])
        raise AssertionError(f"unexpected query: {sql}")


class _FakeEngine:
    def __init__(self, conn=None, exc=None):
        self._conn = conn
        self._exc = exc

    def connect(self):
        if self._exc is not None:
            raise self._exc
        return self._conn

    @property
    def conn(self):
        return self._conn


def _engine(
    schema="eventbook",
    tables=None,
    version_rows=None,
    exc=None,
    fail_on=None,
):
    if exc is not None:
        return _FakeEngine(exc=exc)
    if tables is None:
        tables = sorted(EXPECTED_TABLES)
    if version_rows is None:
        version_rows = {"eventbook": ["rev-0001"]}
    conn = _FakeConn(schema, tables, version_rows, fail_on=fail_on)
    engine = _FakeEngine(conn=conn)
    return engine


def _base_settings() -> Settings:
    return Settings(
        DATABASE_URL="postgresql+psycopg://u:p@db:5432/eventbook_dev",
        ALLOWED_ORIGINS="http://localhost:3000",
        EXPECTED_ALEMBIC_REVISION=None,
    )


def test_missing_schema_not_ready() -> None:
    ready, actual = get_readiness(_engine(schema=None), None)
    assert (ready, actual) == (False, None)


def test_incomplete_tables_not_ready() -> None:
    partial = sorted(EXPECTED_TABLES)[:-1]
    ready, _ = get_readiness(_engine(tables=partial), None)
    assert ready is False


def test_missing_version_row_not_ready() -> None:
    ready, _ = get_readiness(_engine(version_rows={"eventbook": []}), None)
    assert ready is False


def test_version_table_absent_not_ready_without_failed_select() -> None:
    engine = _engine(version_rows={})
    ready, _ = get_readiness(engine, None)
    assert ready is False
    # Existence check ran, but no version SELECT was attempted, so the
    # transaction was never aborted by a missing-table error.
    assert engine.conn is not None
    assert engine.conn.aborted is False
    assert not [q for q in engine.conn.query_log if "alembic_version" in q and "information_schema" not in q]


def test_version_only_in_public_is_ready() -> None:
    # Regression for the aborted-transaction fallback bug: the old code
    # SELECTed eventbook.alembic_version first, aborted the transaction,
    # and the public fallback could never succeed. Existence-first lookup
    # queries only public here.
    engine = _engine(version_rows={"public": ["rev-0001"]})
    ready, actual = get_readiness(engine, None)
    assert (ready, actual) == (True, "rev-0001")
    assert engine.conn is not None
    assert engine.conn.aborted is False
    selects = [q for q in engine.conn.query_log if "FROM public.alembic_version" in q]
    assert len(selects) == 1
    assert not [q for q in engine.conn.query_log if "FROM eventbook.alembic_version" in q]


def test_version_only_in_eventbook_is_ready() -> None:
    engine = _engine(version_rows={"eventbook": ["rev-0001"]})
    ready, actual = get_readiness(engine, None)
    assert (ready, actual) == (True, "rev-0001")
    assert not [q for q in engine.conn.query_log if "FROM public.alembic_version" in q]


def test_version_in_both_prefers_eventbook() -> None:
    engine = _engine(version_rows={"eventbook": ["rev-eb"], "public": ["rev-pub"]})
    ready, actual = get_readiness(engine, None)
    assert (ready, actual) == (True, "rev-eb")


def test_ready_without_expected_revision() -> None:
    ready, actual = get_readiness(_engine(version_rows={"eventbook": ["rev-0001"]}), None)
    assert (ready, actual) == (True, "rev-0001")


def test_revision_mismatch_not_ready() -> None:
    ready, actual = get_readiness(_engine(version_rows={"eventbook": ["rev-0001"]}), "rev-0002")
    assert ready is False
    assert actual == "rev-0001"


def test_revision_match_ready() -> None:
    ready, actual = get_readiness(_engine(version_rows={"eventbook": ["rev-0001"]}), "rev-0001")
    assert (ready, actual) == (True, "rev-0001")


def test_connection_failure_not_ready() -> None:
    ready, actual = get_readiness(_engine(exc=RuntimeError("down")), None)
    assert (ready, actual) == (False, None)


def test_health_503_envelope_has_no_leak() -> None:
    app = create_app(_base_settings())
    with patch("app.main.get_engine", side_effect=RuntimeError("db down")):
        resp = TestClient(app).get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body == {
        "error": {"code": "TEMPORARILY_UNAVAILABLE", "message": "Service temporarily unavailable."}
    }
    assert "psycopg" not in resp.text
    assert "DATABASE_URL" not in resp.text


def test_health_200_when_ready() -> None:
    app = create_app(_base_settings())
    with patch("app.main.get_engine", return_value=_engine()):
        resp = TestClient(app).get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
