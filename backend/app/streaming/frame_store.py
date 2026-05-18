"""Thread-safe latest-frame holder.

The capture thread calls `update` (on success) or `mark_disconnected` (after
repeated failures); HTTP handlers call `snapshot` / `depth_at` / `is_connected`.
Locking is fine-grained and short — handlers never wait on the camera.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class StoredFrame:
    frame_id: int
    color_jpeg: bytes
    depth_jpeg: bytes
    depth_units: np.ndarray  # (H, W) uint16


class FrameStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._new_frame = threading.Condition(self._lock)
        self._latest: StoredFrame | None = None
        self._counter: int = 0
        self._connected: bool = False

    def update(self, color_jpeg: bytes, depth_jpeg: bytes, depth_units: np.ndarray) -> None:
        with self._new_frame:
            self._counter += 1
            self._latest = StoredFrame(
                frame_id=self._counter,
                color_jpeg=color_jpeg,
                depth_jpeg=depth_jpeg,
                depth_units=depth_units,
            )
            self._connected = True
            self._new_frame.notify_all()

    def mark_disconnected(self) -> None:
        """Drop the cached frame and flip to disconnected. Idempotent."""
        with self._new_frame:
            if not self._connected and self._latest is None:
                return
            self._connected = False
            self._latest = None
            self._new_frame.notify_all()

    @property
    def is_connected(self) -> bool:
        with self._lock:
            return self._connected

    def snapshot(self) -> StoredFrame | None:
        with self._lock:
            return self._latest

    def wait_for_new(self, last_seen_id: int, timeout: float = 1.0) -> StoredFrame | None:
        with self._new_frame:
            self._new_frame.wait_for(
                lambda: (
                    not self._connected
                    or (self._latest is not None and self._latest.frame_id != last_seen_id)
                ),
                timeout=timeout,
            )
            return self._latest

    def depth_at(self, x: int, y: int) -> int | None:
        snap = self.snapshot()
        if snap is None:
            return None
        depth = snap.depth_units
        h, w = depth.shape
        if not (0 <= x < w and 0 <= y < h):
            return None
        return int(depth[y, x])
