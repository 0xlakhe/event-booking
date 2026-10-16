"""Explicit local role and database provisioning.

Tools-service only (`docker compose --profile tools run --rm tools
python -m app.bootstrap_local`). Idempotent: existing roles keep their
passwords (never rotated silently) and existing databases are preserved.
Grants CONNECT per environment pair so dev and test credentials cannot
cross over; hosted-only roles are handled conditionally.
"""

import os
from dataclasses import dataclass

import psycopg
from psycopg import sql


@dataclass(frozen=True)
class BootstrapConfig:
    host: str
    bootstrap_user: str
    bootstrap_password: str
    dev_db: str
    test_db: str
    dev_migrator: str
    dev_migrator_password: str
    dev_runtime: str
    dev_runtime_password: str
    test_migrator: str
    test_migrator_password: str
    test_runtime: str
    test_runtime_password: str

    @staticmethod
    def _required(name: str) -> str:
        value = os.environ.get(name, "")
        if not value:
            raise RuntimeError(f"{name} is required for bootstrap")
        return value

    @classmethod
    def from_env(cls) -> "BootstrapConfig":
        return cls(
            host=os.environ.get("DB_HOST", "db"),
            bootstrap_user=cls._required("POSTGRES_BOOTSTRAP_USER"),
            bootstrap_password=cls._required("POSTGRES_BOOTSTRAP_PASSWORD"),
            dev_db=os.environ.get("POSTGRES_DB", "eventbook_dev"),
            test_db=os.environ.get("POSTGRES_TEST_DB", "eventbook_test"),
            dev_migrator=cls._required("POSTGRES_MIGRATION_USER"),
            dev_migrator_password=cls._required("POSTGRES_MIGRATION_PASSWORD"),
            dev_runtime=cls._required("POSTGRES_RUNTIME_USER"),
            dev_runtime_password=cls._required("POSTGRES_RUNTIME_PASSWORD"),
            test_migrator=cls._required("POSTGRES_TEST_MIGRATION_USER"),
            test_migrator_password=cls._required("POSTGRES_TEST_MIGRATION_PASSWORD"),
            test_runtime=cls._required("POSTGRES_TEST_RUNTIME_USER"),
            test_runtime_password=cls._required("POSTGRES_TEST_RUNTIME_PASSWORD"),
        )


def _role_exists(cur: psycopg.Cursor, name: str) -> bool:
    cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,))
    return cur.fetchone() is not None


def _db_exists(cur: psycopg.Cursor, name: str) -> bool:
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,))
    return cur.fetchone() is not None


def ensure_role(cur: psycopg.Cursor, name: str, password: str) -> str:
    """Create a LOGIN role when missing; never touch an existing password."""
    if _role_exists(cur, name):
        cur.execute(sql.SQL("ALTER ROLE {} WITH LOGIN").format(sql.Identifier(name)))
        return "kept"
    # Utility statements take no bound parameters; Literal quotes safely.
    cur.execute(
        sql.SQL("CREATE ROLE {} WITH LOGIN PASSWORD {}").format(
            sql.Identifier(name), sql.Literal(password)
        )
    )
    return "created"


def ensure_database(cur: psycopg.Cursor, name: str) -> str:
    if _db_exists(cur, name):
        return "kept"
    cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    return "created"


def provision(cfg: BootstrapConfig) -> dict[str, str]:
    """Create roles/databases and wire per-environment CONNECT grants."""
    report: dict[str, str] = {}
    admin = {
        "dbname": "postgres",
        "user": cfg.bootstrap_user,
        "password": cfg.bootstrap_password,
        "host": cfg.host,
        "autocommit": True,
    }
    with psycopg.connect(**admin) as conn:
        with conn.cursor() as cur:
            pairs = [
                (cfg.dev_migrator, cfg.dev_migrator_password),
                (cfg.dev_runtime, cfg.dev_runtime_password),
                (cfg.test_migrator, cfg.test_migrator_password),
                (cfg.test_runtime, cfg.test_runtime_password),
            ]
            for name, password in pairs:
                report[f"role:{name}"] = ensure_role(cur, name, password)
            report["db:" + cfg.dev_db] = ensure_database(cur, cfg.dev_db)
            report["db:" + cfg.test_db] = ensure_database(cur, cfg.test_db)

    # Per-database CONNECT isolation (separate connections per target DB).
    grants = [
        (cfg.dev_db, [cfg.dev_migrator, cfg.dev_runtime], [cfg.test_migrator, cfg.test_runtime]),
        (cfg.test_db, [cfg.test_migrator, cfg.test_runtime], [cfg.dev_migrator, cfg.dev_runtime]),
    ]
    for dbname, allowed, denied in grants:
        migrator = allowed[0]
        with psycopg.connect(
            dbname=dbname, user=cfg.bootstrap_user, password=cfg.bootstrap_password,
            host=cfg.host, autocommit=True,
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM PUBLIC").format(sql.Identifier(dbname)))
                for name in allowed:
                    cur.execute(
                        sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                            sql.Identifier(dbname), sql.Identifier(name)
                        )
                    )
                for name in denied:
                    cur.execute(
                        sql.SQL("REVOKE CONNECT ON DATABASE {} FROM {}").format(
                            sql.Identifier(dbname), sql.Identifier(name)
                        )
                    )
                # Migrators need CREATE so the migration can own the schema.
                cur.execute(
                    sql.SQL("GRANT CREATE ON DATABASE {} TO {}").format(
                        sql.Identifier(dbname), sql.Identifier(migrator)
                    )
                )
                # Empty schema shell owned by the migrator. Alembic stamps
                # its version row before the migration body runs, so the
                # schema must already exist; tables and grants stay in the
                # migration itself.
                cur.execute(
                    sql.SQL("CREATE SCHEMA IF NOT EXISTS eventbook AUTHORIZATION {}").format(
                        sql.Identifier(migrator)
                    )
                )
        report[f"grants:{dbname}"] = "isolated"

    # Hosted-only roles (Supabase) must never reach local databases.
    # Absent locally: reported as skipped, nothing required of them.
    with psycopg.connect(**admin) as conn:
        with conn.cursor() as cur:
            for hosted in ("anon", "authenticated", "service_role"):
                if not _role_exists(cur, hosted):
                    report[f"hosted:{hosted}"] = "absent-skipped"
                    continue
                for dbname in (cfg.dev_db, cfg.test_db):
                    cur.execute(
                        sql.SQL("REVOKE CONNECT ON DATABASE {} FROM {}").format(
                            sql.Identifier(dbname), sql.Identifier(hosted)
                        )
                    )
                report[f"hosted:{hosted}"] = "revoked"
    return report


def main() -> None:
    cfg = BootstrapConfig.from_env()
    report = provision(cfg)
    for key in sorted(report):
        print(f"{key}: {report[key]}")


if __name__ == "__main__":
    main()
