from __future__ import annotations

import pytest

from python.statistics import RollingStatistics


# ---------------------------------------------------------------------------
# Constructor validation
# ---------------------------------------------------------------------------


def test_invalid_window_size_raises():
    with pytest.raises(ValueError, match="positive"):
        RollingStatistics(window_size=0)


def test_negative_window_size_raises():
    with pytest.raises(ValueError, match="positive"):
        RollingStatistics(window_size=-1)


# ---------------------------------------------------------------------------
# Empty state
# ---------------------------------------------------------------------------


def test_empty_snapshot():
    stats = RollingStatistics(window_size=10)
    snap = stats.snapshot()
    assert snap["count"] == 0
    assert snap["mean"] is None
    assert snap["min"] is None
    assert snap["max"] is None
    assert snap["delta"] is None
    assert snap["fields"] == {}


# ---------------------------------------------------------------------------
# Basic statistics
# ---------------------------------------------------------------------------


def test_single_value():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"value": 42}})
    snap = stats.snapshot()
    assert snap["count"] == 1
    assert snap["mean"] == 42.0
    assert snap["min"] == 42.0
    assert snap["max"] == 42.0
    assert snap["delta"] == 0.0


def test_multiple_values():
    stats = RollingStatistics(window_size=10)
    for v in [10, 20, 30]:
        stats.update({"parsed": {"value": v}})
    snap = stats.snapshot()
    assert snap["count"] == 3
    assert snap["mean"] == 20.0
    assert snap["min"] == 10.0
    assert snap["max"] == 30.0
    assert snap["delta"] == 20.0  # 30 - 10


# ---------------------------------------------------------------------------
# Rolling window
# ---------------------------------------------------------------------------


def test_rolling_window_evicts_old():
    stats = RollingStatistics(window_size=3)
    for v in [10, 20, 30, 40]:
        stats.update({"parsed": {"value": v}})
    snap = stats.snapshot()
    assert snap["count"] == 3
    # Only [20, 30, 40] remain
    assert snap["min"] == 20.0
    assert snap["max"] == 40.0
    assert snap["mean"] == 30.0


# ---------------------------------------------------------------------------
# Multi-field frames
# ---------------------------------------------------------------------------


def test_per_field_statistics():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"temp": 25, "humidity": 60}})
    stats.update({"parsed": {"temp": 30, "humidity": 70}})
    snap = stats.snapshot()

    assert "temp" in snap["fields"]
    assert "humidity" in snap["fields"]
    assert snap["fields"]["temp"]["mean"] == 27.5
    assert snap["fields"]["humidity"]["mean"] == 65.0


def test_primary_value_prefers_value_key():
    """When a frame has a 'value' key, it should be used as the primary metric."""
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"value": 100, "other": 200}})
    snap = stats.snapshot()
    # Primary mean should come from "value", not "other"
    assert snap["mean"] == 100.0


def test_primary_value_fallback_to_first_sorted_key():
    """Without 'value' key, the first sorted key is used as primary."""
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"beta": 50, "alpha": 100}})
    snap = stats.snapshot()
    # "alpha" sorts first → primary = 100
    assert snap["mean"] == 100.0


# ---------------------------------------------------------------------------
# Non-numeric / edge cases
# ---------------------------------------------------------------------------


def test_boolean_values_skipped():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"flag": True, "value": 5}})
    snap = stats.snapshot()
    assert "flag" not in snap["fields"]
    assert snap["mean"] == 5.0


def test_non_dict_parsed_ignored():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": None})
    stats.update({"parsed": "not a dict"})
    snap = stats.snapshot()
    assert snap["count"] == 2
    assert snap["mean"] is None  # no numeric samples extracted


def test_inf_nan_skipped():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"value": float("inf")}})
    stats.update({"parsed": {"value": float("nan")}})
    snap = stats.snapshot()
    assert snap["mean"] is None


# ---------------------------------------------------------------------------
# Clear
# ---------------------------------------------------------------------------


def test_clear_resets():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"value": 42}})
    stats.clear()
    snap = stats.snapshot()
    assert snap["count"] == 0
    assert snap["mean"] is None


# ---------------------------------------------------------------------------
# Snapshot caching
# ---------------------------------------------------------------------------


def test_snapshot_is_deep_copy():
    stats = RollingStatistics(window_size=10)
    stats.update({"parsed": {"value": 1}})
    snap1 = stats.snapshot()
    snap1["mean"] = 999
    snap2 = stats.snapshot()
    assert snap2["mean"] == 1.0  # not mutated
