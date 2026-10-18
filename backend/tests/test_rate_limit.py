"""Unit tests for the in-process failed-login limiter (bonus work).

The limiter is exercised directly with an injected clock, so window
expiry and bucket eviction are asserted without sleeping. HTTP-level
behavior is covered in `test_auth.py`.
"""

import threading

import pytest

from app.rate_limit import SlidingWindowLimiter


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_allows_until_limit_then_reports_retry_after() -> None:
    clock = _Clock()
    limiter = SlidingWindowLimiter(limit=3, window_seconds=60, clock=clock)
    for _ in range(2):
        assert limiter.retry_after("k") is None
        limiter.record_failure("k")
    assert limiter.retry_after("k") is None  # two failures are still below the limit
    limiter.record_failure("k")
    retry = limiter.retry_after("k")
    assert retry is not None and 59 <= retry <= 60
    clock.now = 30.0
    retry = limiter.retry_after("k")
    assert retry is not None and 29 <= retry <= 30


def test_window_expiry_allows_again() -> None:
    clock = _Clock()
    limiter = SlidingWindowLimiter(limit=2, window_seconds=60, clock=clock)
    limiter.record_failure("k")
    limiter.record_failure("k")
    assert limiter.retry_after("k") is not None
    clock.now = 59.9
    assert limiter.retry_after("k") is not None
    clock.now = 60.0
    assert limiter.retry_after("k") is None


def test_clear_resets_bucket() -> None:
    clock = _Clock()
    limiter = SlidingWindowLimiter(limit=2, window_seconds=60, clock=clock)
    limiter.record_failure("k")
    limiter.record_failure("k")
    assert limiter.retry_after("k") is not None
    limiter.clear("k")
    assert limiter.retry_after("k") is None
    limiter.record_failure("k")
    assert limiter.retry_after("k") is None


def test_buckets_are_isolated_by_key() -> None:
    clock = _Clock()
    limiter = SlidingWindowLimiter(limit=1, window_seconds=60, clock=clock)
    limiter.record_failure("a")
    assert limiter.retry_after("a") is not None
    assert limiter.retry_after("b") is None


def test_bucket_table_is_bounded_and_evicts_oldest() -> None:
    clock = _Clock()
    limiter = SlidingWindowLimiter(limit=1, window_seconds=60, max_keys=2, clock=clock)
    limiter.record_failure("k1")
    limiter.record_failure("k2")
    limiter.record_failure("k3")  # evicts k1
    assert limiter.retry_after("k1") is None
    assert limiter.retry_after("k2") is not None
    assert limiter.retry_after("k3") is not None


def test_concurrent_records_are_counted() -> None:
    limiter = SlidingWindowLimiter(limit=3, window_seconds=60)
    threads = [
        threading.Thread(target=limiter.record_failure, args=("k",)) for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert all(not thread.is_alive() for thread in threads)
    assert limiter.retry_after("k") is not None


def test_invalid_configuration_rejected() -> None:
    with pytest.raises(ValueError):
        SlidingWindowLimiter(limit=0, window_seconds=60)
    with pytest.raises(ValueError):
        SlidingWindowLimiter(limit=1, window_seconds=0)
    with pytest.raises(ValueError):
        SlidingWindowLimiter(limit=1, window_seconds=60, max_keys=0)
