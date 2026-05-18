"""MJPEG streaming generators for `multipart/x-mixed-replace`.

Browsers render this directly via `<img src=...>` — no client-side decoding.
When the camera disconnects, the generator returns so the HTTP response ends
cleanly and the browser stops rendering the stale frame.
"""
from __future__ import annotations

from collections.abc import Generator
from typing import Literal

from app.streaming.frame_store import FrameStore

BOUNDARY = "frame"
MEDIA_TYPE = f"multipart/x-mixed-replace; boundary={BOUNDARY}"


def mjpeg_generator(
    store: FrameStore,
    feed: Literal["color", "depth"],
    *,
    timeout: float = 1.0,
) -> Generator[bytes, None, None]:
    last_seen = -1
    while True:
        frame = store.wait_for_new(last_seen, timeout=timeout)
        if not store.is_connected:
            return
        if frame is None:
            continue
        last_seen = frame.frame_id
        payload = frame.color_jpeg if feed == "color" else frame.depth_jpeg
        yield (
            f"--{BOUNDARY}\r\n"
            f"Content-Type: image/jpeg\r\n"
            f"Content-Length: {len(payload)}\r\n\r\n"
        ).encode("ascii") + payload + b"\r\n"
