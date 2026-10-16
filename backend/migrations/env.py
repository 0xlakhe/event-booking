"""Alembic environment: explicit migration URL, no automatic seeding."""

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

# Ensure `app` imports from this backend checkout (not only site-packages).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.models import Base  # noqa: E402

config = context.config
if config.config_file_name is not None:
    # Never mute application loggers in-process: the test harness runs
    # migrations and assertions in one process, and silenced loggers
    # would hide the very output log-safety tests inspect.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def get_migration_url() -> str:
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        raise RuntimeError("MIGRATION_DATABASE_URL is required (see .env.example)")
    if not url.startswith("postgresql+psycopg://"):
        raise ValueError("MIGRATION_DATABASE_URL must use postgresql+psycopg:// scheme")
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=get_migration_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        # Version row lives beside the app tables: the migrator owns the
        # schema (no CREATE on public needed) and readiness only needs
        # SELECT on this one row, granted explicitly in the migration.
        version_table_schema="eventbook",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(get_migration_url(), pool_pre_ping=True)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table_schema="eventbook",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
