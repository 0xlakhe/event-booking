"""In-process failed-login throttling.

A sliding window of failure timestamps per bucket key. State is
process-local: adequate for local development and a single backend
process, and with multiple instances (production may run several) each
instance bounds its own buckets — recorded as a limitation in
TECHNICAL_DESIGN.md. The bucket table is bounded so arbitrary emails
cannot grow it without limit.
"""

import threading
import time
from collections import deque
from typing import Callable


class SlidingWindowLimiter:
    """Blocks a bucket once `limit` failures fall inside the window.

    Only failures are recorded: successful requests (any endpoint) are
    never throttled, and a successful login clears its own bucket.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float,
        max_keys: int = 1024,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit < 1:
            raise ValueError("limit must be at least 1")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        if max_keys < 1:
            raise ValueError("max_keys must be at least 1")
        self._limit = limit
        self._window = float(window_seconds)
        self._max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        self._failures: dict[str, deque[float]] = {}

    def _prune(self, hits: deque[float], now: float) -> None:
        cutoff = now - self._window
        while hits and hits[0] <= cutoff:
            hits.popleft()

    def retry_after(self, key: str) -> float | None:
        """Seconds until the bucket may attempt again, or None when allowed."""
        now = self._clock()
        with self._lock:
            hits = self._failures.get(key)
            if hits is None:
                return None
            self._prune(hits, now)
            if not hits:
                del self._failures[key]
                return None
            if len(hits) < self._limit:
                return None
            return hits[0] + self._window - now

    def record_failure(self, key: str) -> None:
        now = self._clock()
        with self._lock:
            hits = self._failures.get(key)
            if hits is None:
                if len(self._failures) >= self._max_keys:
                    # Drop the oldest bucket when full: entries are short-lived,
                    # so eviction order only needs to stay bounded.
                    self._failures.pop(next(iter(self._failures)), None)
                hits = deque()
                self._failures[key] = hits
            else:
                self._prune(hits, now)
            hits.append(now)

    def clear(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)
