"""Shared SQL collection pagination (TASK-004; reused by later tasks).

Small validation helper only: page/page_size bounds from the design
contract. Callers run their own filtered COUNT + LIMIT/OFFSET in one
read transaction and wrap rows in the collection envelope here.
"""

from .errors import ApiError

DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 50


def parse_pagination(page: int = DEFAULT_PAGE, page_size: int = DEFAULT_PAGE_SIZE) -> tuple[int, int]:
    """Validate raw collection parameters; 422 with field errors when out of bounds."""
    errors: dict[str, str] = {}
    if page < 1:
        errors["page"] = "Page must be at least 1."
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        errors["page_size"] = f"Page size must be between 1 and {MAX_PAGE_SIZE}."
    if errors:
        raise ApiError(422, "VALIDATION_ERROR", "Invalid input.", fields=errors)
    return page, page_size


def envelope(items: list[dict], page: int, page_size: int, total: int) -> dict:
    """Collection envelope shared by every paginated listing."""
    return {"items": items, "page": page, "page_size": page_size, "total": total}
