"""Calibration persistence + in-memory holder.

The calibration is a small singleton — one calibration per camera install.
Stored at `backend/calibration.json` (gitignored), loaded on app startup,
replaced atomically on `POST /api/calibration`.
"""
from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.calibration.transform import Plane, RigidTransform, fit_plane, kabsch_rigid

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PointPair:
    pixel: tuple[int, int]
    camera_xyz_m: tuple[float, float, float]
    robot_xyz_m: tuple[float, float, float]


@dataclass(frozen=True)
class Calibration:
    created_at: str  # ISO 8601 UTC
    units_input: str  # "mm" or "m" — what the user typed
    point_pairs: tuple[PointPair, ...]
    transform: RigidTransform
    plane: Plane

    @property
    def num_points(self) -> int:
        return len(self.point_pairs)

    @property
    def rmse_mm(self) -> float:
        return self.transform.rmse_m * 1000.0


def compute(point_pairs: list[PointPair], units_input: str) -> Calibration:
    """Run Kabsch + plane fit, build a Calibration object."""
    cam = np.array([pp.camera_xyz_m for pp in point_pairs], dtype=np.float64)
    rob = np.array([pp.robot_xyz_m for pp in point_pairs], dtype=np.float64)
    transform = kabsch_rigid(cam, rob)
    plane = fit_plane(cam)
    return Calibration(
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        units_input=units_input,
        point_pairs=tuple(point_pairs),
        transform=transform,
        plane=plane,
    )


def to_json(cal: Calibration) -> dict:
    return {
        "created_at": cal.created_at,
        "units_input": cal.units_input,
        "rmse_m": cal.transform.rmse_m,
        "transform": {
            "R": cal.transform.R.tolist(),
            "t": cal.transform.t.tolist(),
        },
        "plane": {
            "normal": cal.plane.normal.tolist(),
            "centroid": cal.plane.centroid.tolist(),
        },
        "point_pairs": [
            {
                "pixel": list(pp.pixel),
                "camera_xyz_m": list(pp.camera_xyz_m),
                "robot_xyz_m": list(pp.robot_xyz_m),
            }
            for pp in cal.point_pairs
        ],
    }


def from_json(d: dict) -> Calibration:
    transform = RigidTransform(
        R=np.array(d["transform"]["R"], dtype=np.float64),
        t=np.array(d["transform"]["t"], dtype=np.float64),
        rmse_m=float(d["rmse_m"]),
    )
    plane = Plane(
        normal=np.array(d["plane"]["normal"], dtype=np.float64),
        centroid=np.array(d["plane"]["centroid"], dtype=np.float64),
    )
    pairs = tuple(
        PointPair(
            pixel=(int(p["pixel"][0]), int(p["pixel"][1])),
            camera_xyz_m=tuple(float(v) for v in p["camera_xyz_m"]),
            robot_xyz_m=tuple(float(v) for v in p["robot_xyz_m"]),
        )
        for p in d["point_pairs"]
    )
    return Calibration(
        created_at=str(d["created_at"]),
        units_input=str(d.get("units_input", "mm")),
        point_pairs=pairs,
        transform=transform,
        plane=plane,
    )


@dataclass
class CalibrationStore:
    path: Path
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _data: Calibration | None = None

    def load(self) -> None:
        if not self.path.exists():
            log.info("No calibration found at %s", self.path)
            return
        try:
            with self.path.open() as f:
                self._data = from_json(json.load(f))
            log.info(
                "Loaded calibration from %s (n=%d, RMSE %.2f mm, %s)",
                self.path, self._data.num_points, self._data.rmse_mm, self._data.created_at,
            )
        except Exception:
            log.exception("Failed to load calibration; ignoring")

    def get(self) -> Calibration | None:
        with self._lock:
            return self._data

    def save(self, cal: Calibration) -> None:
        with self._lock:
            self._data = cal
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with tmp.open("w") as f:
                json.dump(to_json(cal), f, indent=2)
            tmp.replace(self.path)
        log.info("Saved calibration (n=%d, RMSE %.2f mm)", cal.num_points, cal.rmse_mm)

    def clear(self) -> None:
        with self._lock:
            self._data = None
            if self.path.exists():
                self.path.unlink()
        log.info("Cleared calibration")
