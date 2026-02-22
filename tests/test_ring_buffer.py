from __future__ import annotations

import pytest

from python.plugin import RingBuffer
from python.ring_buffer import normalize_frame_delimiter


# ---------------------------------------------------------------------------
# Basic frame extraction
# ---------------------------------------------------------------------------


def test_fragment_kept_until_delimiter():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1')
    assert ring.peek_frame() is None


def test_max_frames_trimming():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|{"value":3}|{"value":4}|')
    assert ring.read_frame() == b'{"value":2}'


def test_peek_frame():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|{"value":3}|{"value":4}|')
    ring.read_frame()  # consume first
    assert ring.peek_frame() == b'{"value":3}'


def test_get_last_n():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|{"value":3}|{"value":4}|')
    last_two = ring.get_last_n(2)
    assert last_two == [b'{"value":3}', b'{"value":4}']


def test_clear():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|')
    ring.clear()
    assert ring.read_frame() is None


# ---------------------------------------------------------------------------
# Multi-append (incremental feeding)
# ---------------------------------------------------------------------------


def test_multi_append_builds_frame():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"val')
    assert ring.read_frame() is None
    ring.append(b'ue":1}|')
    assert ring.read_frame() == b'{"value":1}'


def test_multi_append_across_delimiter():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"a":1}')
    ring.append(b"|")
    ring.append(b'{"a":2}|')
    assert ring.read_frame() == b'{"a":1}'
    assert ring.read_frame() == b'{"a":2}'


# ---------------------------------------------------------------------------
# Buffer overflow
# ---------------------------------------------------------------------------


def test_buffer_overflow_truncates_oldest_data():
    ring = RingBuffer(buffer_size=20, max_frames=5, frame_delimiter="|")
    # Feed data that exceeds buffer_size — oldest bytes are dropped.
    ring.append(b"aaaaaaaaaa")  # 10 bytes
    ring.append(b"bbbbbbbbbb")  # 10 bytes
    ring.append(b"cccccccccc|")  # 11 bytes — overflows, drops oldest
    # Even if the oldest bytes are lost, the delimiter should still extract a frame.
    frame = ring.read_frame()
    # The exact frame depends on how much was truncated, but a frame should be extracted.
    assert frame is not None


# ---------------------------------------------------------------------------
# Usage ratio
# ---------------------------------------------------------------------------


def test_usage_ratio_empty():
    ring = RingBuffer(buffer_size=100, max_frames=5, frame_delimiter="|")
    assert ring.usage_ratio == 0.0


def test_usage_ratio_partial():
    ring = RingBuffer(buffer_size=100, max_frames=5, frame_delimiter="|")
    ring.append(b"a" * 50)  # no delimiter, stays in buffer
    assert 0.4 <= ring.usage_ratio <= 0.6


def test_usage_ratio_capped_at_one():
    ring = RingBuffer(buffer_size=10, max_frames=5, frame_delimiter="|")
    ring.append(b"x" * 20)
    assert ring.usage_ratio <= 1.0


# ---------------------------------------------------------------------------
# Delimiter types
# ---------------------------------------------------------------------------


def test_string_delimiter():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b"hello|world|")
    assert ring.read_frame() == b"hello"
    assert ring.read_frame() == b"world"


def test_newline_delimiter():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="\n")
    ring.append(b'{"v":1}\n{"v":2}\n')
    assert ring.read_frame() == b'{"v":1}'
    assert ring.read_frame() == b'{"v":2}'


def test_multi_byte_delimiter():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter=b"\r\n")
    ring.append(b"frame1\r\nframe2\r\n")
    assert ring.read_frame() == b"frame1"
    assert ring.read_frame() == b"frame2"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_invalid_buffer_size_raises():
    with pytest.raises(ValueError, match="positive"):
        RingBuffer(buffer_size=0, max_frames=3, frame_delimiter="|")


def test_negative_buffer_size_raises():
    with pytest.raises(ValueError, match="positive"):
        RingBuffer(buffer_size=-1, max_frames=3, frame_delimiter="|")


def test_invalid_max_frames_raises():
    with pytest.raises(ValueError, match="positive"):
        RingBuffer(buffer_size=64, max_frames=0, frame_delimiter="|")


def test_empty_delimiter_raises():
    with pytest.raises(ValueError, match="empty"):
        RingBuffer(buffer_size=64, max_frames=3, frame_delimiter=b"")


def test_append_non_bytes_raises():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    with pytest.raises(TypeError):
        ring.append("not bytes")  # type: ignore[arg-type]


def test_append_empty_is_noop():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b"")
    assert ring.read_frame() is None


def test_get_last_n_zero_returns_empty():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b"a|b|")
    assert ring.get_last_n(0) == []


def test_get_last_n_negative_returns_empty():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b"a|b|")
    assert ring.get_last_n(-1) == []


# ---------------------------------------------------------------------------
# normalize_frame_delimiter
# ---------------------------------------------------------------------------


def test_normalize_str():
    assert normalize_frame_delimiter("|") == b"|"


def test_normalize_bytes():
    assert normalize_frame_delimiter(b"\n") == b"\n"


def test_normalize_invalid_type_raises():
    with pytest.raises(TypeError):
        normalize_frame_delimiter(123)  # type: ignore[arg-type]


def test_normalize_empty_str_raises():
    with pytest.raises(ValueError, match="empty"):
        normalize_frame_delimiter("")
