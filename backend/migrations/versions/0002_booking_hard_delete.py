"""Grant runtime the minimum privilege required for hard-delete cancellation."""

import os
import re

from alembic import op
from sqlalchemy import text

revision = "0002_booking_hard_delete"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


_ROLE_RE = re.compile(r"[a-z_][a-z0-9_]*")


def _runtime_role() -> str:
    runtime = os.environ.get("EVENTBOOK_RUNTIME_ROLE", "eventbook_runtime")
    if not _ROLE_RE.fullmatch(runtime):
        raise ValueError(f"Refusing suspicious runtime role name: {runtime!r}")
    return runtime


def upgrade() -> None:
    runtime = _runtime_role()
    op.execute(
        text(f'REVOKE UPDATE (cancelled_at) ON eventbook.bookings FROM "{runtime}"')
    )
    op.execute(text(f'GRANT DELETE ON eventbook.bookings TO "{runtime}"'))


def downgrade() -> None:
    runtime = _runtime_role()
    op.execute(text(f'REVOKE DELETE ON eventbook.bookings FROM "{runtime}"'))
    op.execute(
        text(f'GRANT UPDATE (cancelled_at) ON eventbook.bookings TO "{runtime}"')
    )
