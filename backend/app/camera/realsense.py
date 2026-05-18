"""Clean Intel RealSense D435 wrapper.

Replaces the legacy `realsense_utils.py`. Differences:
- Context-managed lifecycle (pipeline always stops cleanly).
- Filters declared once and composed; no inline magic.
- Intrinsics + depth scale exposed as a typed dataclass.
- Depth is aligned to the color frame so a click on the RGB image maps
  directly to the same pixel in depth.
- USB type is detected before starting the pipeline so we can pick a
  profile that actually fits the available bandwidth.
"""
from __future__ import annotations

import logging
from contextlib import AbstractContextManager
from dataclasses import dataclass
from types import TracebackType
from typing import Self

import numpy as np
import pyrealsense2 as rs

from app.config import USB2_PROFILE, USB3_PROFILE, CameraMode, CameraProfile

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Intrinsics:
    width: int
    height: int
    fx: float
    fy: float
    ppx: float
    ppy: float
    model: str
    coeffs: tuple[float, ...]

    @classmethod
    def from_rs(cls, intr: rs.intrinsics) -> "Intrinsics":
        return cls(
            width=intr.width,
            height=intr.height,
            fx=intr.fx,
            fy=intr.fy,
            ppx=intr.ppx,
            ppy=intr.ppy,
            model=str(intr.model),
            coeffs=tuple(intr.coeffs),
        )


@dataclass(frozen=True)
class DeviceInfo:
    name: str
    serial: str
    firmware: str
    usb_type: str  # e.g. "3.2", "2.1"

    @property
    def is_usb2(self) -> bool:
        return self.usb_type.startswith("2")


@dataclass(frozen=True)
class Frame:
    color_bgr: np.ndarray  # (H, W, 3) uint8
    depth_units: np.ndarray  # (H, W) uint16 — multiply by depth_scale for metres


def _query_device_info() -> DeviceInfo:
    """Query the first connected RealSense device without starting a pipeline."""
    ctx = rs.context()
    devices = ctx.query_devices()
    if len(devices) == 0:
        raise RuntimeError("No Intel RealSense devices detected.")
    dev = devices[0]
    return DeviceInfo(
        name=dev.get_info(rs.camera_info.name),
        serial=dev.get_info(rs.camera_info.serial_number),
        firmware=dev.get_info(rs.camera_info.firmware_version),
        usb_type=dev.get_info(rs.camera_info.usb_type_descriptor),
    )


def _resolve_profile(mode: CameraMode, info: DeviceInfo) -> CameraProfile:
    if mode == "usb3":
        return USB3_PROFILE
    if mode == "usb2":
        return USB2_PROFILE
    return USB2_PROFILE if info.is_usb2 else USB3_PROFILE


class RealSenseCamera(AbstractContextManager["RealSenseCamera"]):
    """Owns a RealSense pipeline and produces aligned color+depth frames."""

    def __init__(
        self,
        mode: CameraMode = "auto",
        *,
        spatial_filter: bool = True,
        temporal_filter: bool = True,
        hole_filling: bool = True,
    ) -> None:
        self._mode = mode
        self._device_info: DeviceInfo | None = None
        self._profile: CameraProfile | None = None
        self._pipeline: rs.pipeline | None = None
        self._align: rs.align | None = None
        self._depth_scale: float | None = None
        self._color_intrinsics_raw: rs.intrinsics | None = None
        self._color_intrinsics: Intrinsics | None = None
        self._filters: list[rs.filter] = []
        if spatial_filter:
            self._filters.append(rs.spatial_filter())
        if temporal_filter:
            self._filters.append(rs.temporal_filter())
        if hole_filling:
            self._filters.append(rs.hole_filling_filter())

    def __enter__(self) -> Self:
        info = _query_device_info()
        profile = _resolve_profile(self._mode, info)
        log.info(
            "Detected %s (USB %s, fw %s); mode=%s → profile=%s @ %dx%d %dfps",
            info.name, info.usb_type, info.firmware, self._mode,
            profile.name, profile.width, profile.height, profile.fps,
        )

        config = rs.config()
        config.enable_device(info.serial)
        config.enable_stream(rs.stream.color, profile.width, profile.height, rs.format.bgr8, profile.fps)
        config.enable_stream(rs.stream.depth, profile.width, profile.height, rs.format.z16, profile.fps)

        self._pipeline = rs.pipeline()
        rs_profile = self._pipeline.start(config)
        self._align = rs.align(rs.stream.color)

        depth_sensor = rs_profile.get_device().first_depth_sensor()
        self._depth_scale = float(depth_sensor.get_depth_scale())

        color_profile = rs_profile.get_stream(rs.stream.color).as_video_stream_profile()
        self._color_intrinsics_raw = color_profile.get_intrinsics()
        self._color_intrinsics = Intrinsics.from_rs(self._color_intrinsics_raw)

        self._device_info = info
        self._profile = profile
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._pipeline is not None:
            self._pipeline.stop()
            self._pipeline = None

    @property
    def device_info(self) -> DeviceInfo:
        if self._device_info is None:
            raise RuntimeError("Camera not started; use as a context manager.")
        return self._device_info

    @property
    def profile(self) -> CameraProfile:
        if self._profile is None:
            raise RuntimeError("Camera not started; use as a context manager.")
        return self._profile

    @property
    def color_intrinsics(self) -> Intrinsics:
        if self._color_intrinsics is None:
            raise RuntimeError("Camera not started; use as a context manager.")
        return self._color_intrinsics

    @property
    def depth_scale(self) -> float:
        if self._depth_scale is None:
            raise RuntimeError("Camera not started; use as a context manager.")
        return self._depth_scale

    def read(self, timeout_ms: int = 5000) -> Frame:
        if self._pipeline is None or self._align is None:
            raise RuntimeError("Camera not started; use as a context manager.")
        frames = self._pipeline.wait_for_frames(timeout_ms)
        aligned = self._align.process(frames)
        color = aligned.get_color_frame()
        depth = aligned.get_depth_frame()
        if not color or not depth:
            raise RuntimeError("Did not receive aligned color+depth frame.")
        for f in self._filters:
            depth = f.process(depth)
        return Frame(
            color_bgr=np.asanyarray(color.get_data()),
            depth_units=np.asanyarray(depth.get_data()),
        )

    def deproject(self, x: int, y: int, depth_metres: float) -> tuple[float, float, float]:
        """Pixel (x, y) + depth in metres → (X, Y, Z) in metres in camera frame."""
        if self._color_intrinsics_raw is None:
            raise RuntimeError("Camera not started; use as a context manager.")
        point = rs.rs2_deproject_pixel_to_point(
            self._color_intrinsics_raw, [float(x), float(y)], float(depth_metres)
        )
        return float(point[0]), float(point[1]), float(point[2])
