"""Background capture worker — owns the camera lifecycle.

Two threads:

  * `_run_capture`  — opens the pipeline, reads aligned frames, encodes
                      them as JPEGs into the FrameStore.
  * `_run_watchdog` — actively polls `rs.context.query_devices()` every
                      200 ms. On any change, sets `_device_event`. This is
                      the primary disconnect/reconnect signal because
                      librealsense's hotplug callback is unreliable on
                      Windows (multi-second delays both ways).

Detection latencies under this design:
    unplug  → watchdog notices in ≤200 ms → next loop iteration tears down
              (read timeout caps at 100 ms) → ~300 ms worst case.
    replug  → watchdog notices in ≤200 ms → loop opens new pipeline
              (≤100 ms) → ~300 ms worst case.

The worker also subscribes to the librealsense hotplug callback as a free
backup — if it does fire, great; if not, the watchdog catches it.

Cached attributes on the last-seen camera (intrinsics, depth_scale,
device_info, profile) remain readable after the pipeline is closed, so
HTTP endpoints can keep reporting what device was last attached.
"""
from __future__ import annotations

import logging
import threading

import cv2
import numpy as np
import pyrealsense2 as rs

from app.camera.realsense import RealSenseCamera
from app.config import CameraMode
from app.streaming.frame_store import FrameStore

log = logging.getLogger(__name__)

# Capture loop's steady-state read timeout. The watchdog is the primary
# disconnect signal (≤200 ms), so this just needs to be long enough to
# tolerate normal frame-arrival jitter — especially right after a USB
# reconnect when the pipeline can stall briefly.
READ_TIMEOUT_MS = 500
# Generous timeout for the first frame after pipeline.start(). librealsense
# often takes hundreds of ms (occasionally 1+ s) to warm up before frames
# actually start flowing. Reusing the steady-state timeout here causes us
# to tear down the freshly-opened pipeline on every connect, which feeds
# an open/teardown loop and the camera never appears connected.
WARMUP_TIMEOUT_MS = 3000
# After this many consecutive read failures with the device still present,
# assume the pipeline is wedged and reset it. Real disconnects are caught
# by the watchdog in ≤200 ms, so this only matters for stuck pipelines.
STALL_THRESHOLD = 5
# Watchdog poll interval.
WATCHDOG_INTERVAL_S = 0.2
# Fallback poll inside the capture loop when no device is attached.
DETACHED_WAIT_S = 0.2


def colorize_depth(depth_units: np.ndarray) -> np.ndarray:
    valid = depth_units > 0
    if not valid.any():
        return np.zeros((*depth_units.shape, 3), dtype=np.uint8)
    near, far = np.percentile(depth_units[valid], (2, 98))
    if far <= near:
        far = near + 1
    norm = np.clip((depth_units.astype(np.float32) - near) / (far - near), 0.0, 1.0)
    norm_u8 = (norm * 255).astype(np.uint8)
    coloured = cv2.applyColorMap(norm_u8, cv2.COLORMAP_TURBO)
    coloured[~valid] = 0
    return coloured


class CaptureWorker:
    def __init__(
        self,
        store: FrameStore,
        *,
        mode: CameraMode = "auto",
        spatial_filter: bool = True,
        temporal_filter: bool = True,
        hole_filling: bool = True,
        jpeg_quality: int = 80,
    ) -> None:
        self._store = store
        self._mode = mode
        self._spatial = spatial_filter
        self._temporal = temporal_filter
        self._hole_filling = hole_filling
        self._jpeg_quality = jpeg_quality
        self._encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)]

        self._ctx = rs.context()
        self._lock = threading.Lock()
        self._camera: RealSenseCamera | None = None
        self._last_camera: RealSenseCamera | None = None
        self._device_event = threading.Event()
        self._stop = threading.Event()
        self._capture_thread: threading.Thread | None = None
        self._watchdog_thread: threading.Thread | None = None
        self._consecutive_read_failures = 0

    # ----- public API for HTTP endpoints --------------------------------

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._camera is not None

    @property
    def last_camera(self) -> RealSenseCamera | None:
        with self._lock:
            return self._last_camera

    # ----- lifecycle ----------------------------------------------------

    def start(self) -> None:
        if self._capture_thread is not None:
            raise RuntimeError("CaptureWorker already started")
        self._ctx.set_devices_changed_callback(self._on_devices_changed)
        self._capture_thread = threading.Thread(target=self._run_capture, name="capture", daemon=True)
        self._watchdog_thread = threading.Thread(target=self._run_watchdog, name="watchdog", daemon=True)
        self._capture_thread.start()
        self._watchdog_thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._device_event.set()  # wake the capture loop
        for t in (self._capture_thread, self._watchdog_thread):
            if t is not None:
                t.join(timeout=5.0)
        self._capture_thread = None
        self._watchdog_thread = None
        self._close_camera()

    # ----- callbacks / signals -----------------------------------------

    def _on_devices_changed(self, _info: rs.event_information) -> None:
        # Free backup signal — fires from a librealsense thread.
        self._device_event.set()

    # ----- watchdog -----------------------------------------------------

    def _run_watchdog(self) -> None:
        log.info("Watchdog starting (poll every %dms)", int(WATCHDOG_INTERVAL_S * 1000))
        last_present: bool | None = None
        while not self._stop.is_set():
            present = self._device_present()
            if present != last_present:
                log.info("Watchdog: device %s", "present" if present else "absent")
                last_present = present
                self._device_event.set()
            self._stop.wait(timeout=WATCHDOG_INTERVAL_S)
        log.info("Watchdog stopped")

    # ----- capture loop -------------------------------------------------

    def _run_capture(self) -> None:
        log.info("Capture loop starting")
        while not self._stop.is_set():
            with self._lock:
                cam = self._camera
            if cam is None:
                self._handle_detached()
            else:
                self._handle_attached(cam)
        log.info("Capture loop stopped")

    def _handle_detached(self) -> None:
        if self._device_present():
            self._open_camera()
            return
        # Wait for the watchdog (or hotplug callback) to wake us.
        self._device_event.wait(timeout=DETACHED_WAIT_S)
        self._device_event.clear()

    def _handle_attached(self, cam: RealSenseCamera) -> None:
        # Watchdog/hotplug signal pending? Check whether device is still
        # there before bothering with another read.
        if self._device_event.is_set():
            self._device_event.clear()
            if not self._device_present():
                log.info("Capture: device removed → tearing down pipeline")
                self._tear_down_pipeline()
                return
        try:
            frame = cam.read(timeout_ms=READ_TIMEOUT_MS)
        except Exception as e:
            self._handle_read_failure(e)
            return
        self._consecutive_read_failures = 0
        ok_c, color_jpeg = cv2.imencode(".jpg", frame.color_bgr, self._encode_params)
        depth_bgr = colorize_depth(frame.depth_units)
        ok_d, depth_jpeg = cv2.imencode(".jpg", depth_bgr, self._encode_params)
        if not (ok_c and ok_d):
            log.warning("JPEG encode failed; skipping frame")
            return
        self._store.update(color_jpeg.tobytes(), depth_jpeg.tobytes(), frame.depth_units)

    def _handle_read_failure(self, err: Exception) -> None:
        # If the device is gone, the watchdog will catch up; tear down now.
        if not self._device_present():
            log.info("Capture: read failed and device gone (%s) — tearing down", err)
            self._tear_down_pipeline()
            return
        # Device is still there — the pipeline just didn't deliver a frame
        # in time. Treat as transient unless it persists.
        self._consecutive_read_failures += 1
        if self._consecutive_read_failures >= STALL_THRESHOLD:
            log.warning(
                "Pipeline stalled (%d consecutive read failures) — resetting",
                self._consecutive_read_failures,
            )
            self._tear_down_pipeline()

    def _tear_down_pipeline(self) -> None:
        self._close_camera()
        self._store.mark_disconnected()
        self._consecutive_read_failures = 0

    # ----- camera open/close -------------------------------------------

    def _device_present(self) -> bool:
        try:
            return len(self._ctx.query_devices()) > 0
        except Exception:
            log.exception("query_devices failed")
            return False

    def _open_camera(self) -> None:
        try:
            cam = RealSenseCamera(
                mode=self._mode,
                spatial_filter=self._spatial,
                temporal_filter=self._temporal,
                hole_filling=self._hole_filling,
            )
            cam.__enter__()
        except Exception:
            log.exception("Failed to open camera")
            return
        # Warmup: wait for the first frame with a generous timeout. The
        # frame is discarded; subsequent reads use the fast steady-state
        # timeout. Without this, the steady-state 100 ms timeout fails
        # against the natural pipeline startup latency and we get stuck
        # in an open/teardown loop.
        try:
            cam.read(timeout_ms=WARMUP_TIMEOUT_MS)
        except Exception as e:
            log.warning("Camera warmup failed (%s) — closing pipeline", e)
            try:
                cam.__exit__(None, None, None)
            except Exception:
                log.exception("Error closing camera after warmup failure")
            return
        with self._lock:
            self._camera = cam
            self._last_camera = cam
        log.info(
            "Camera attached: %s (USB %s) → %s",
            cam.device_info.name, cam.device_info.usb_type, cam.profile.name,
        )

    def _close_camera(self) -> None:
        with self._lock:
            cam = self._camera
            self._camera = None
        if cam is None:
            return
        try:
            cam.__exit__(None, None, None)
        except Exception:
            log.exception("Error during camera teardown")
