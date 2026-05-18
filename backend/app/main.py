"""FastAPI entrypoint.

Endpoints:
    GET  /api/health           liveness
    GET  /api/status           camera state + USB type + active profile
    GET  /api/intrinsics       camera intrinsics + depth scale
    GET  /api/calibration      current camera→robot calibration (or null)
    POST /api/calibration      compute + persist a new calibration
    DELETE /api/calibration    discard the current calibration
    GET  /stream/color         MJPEG live RGB feed
    GET  /stream/depth         MJPEG live colorized-depth feed
    POST /api/click            {x, y, snap} → camera-3D + (if calibrated) robot-3D
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.calibration import state as cal_state
from app.config import settings
from app.robot.client import (
    RobotClient,
    RobotError,
    RobotMotionError,
    RobotProtocolError,
    RobotTimeoutError,
)
from app.streaming.capture import CaptureWorker
from app.streaming.frame_store import FrameStore
from app.streaming.mjpeg import MEDIA_TYPE, mjpeg_generator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

@asynccontextmanager
async def lifespan(app: FastAPI):
    store = FrameStore()
    worker = CaptureWorker(
        store,
        mode=settings.camera.mode,
        spatial_filter=settings.camera.enable_spatial_filter,
        temporal_filter=settings.camera.enable_temporal_filter,
        hole_filling=settings.camera.enable_hole_filling,
        jpeg_quality=settings.camera.jpeg_quality,
    )
    worker.start()
    cal = cal_state.CalibrationStore(path=Path(settings.storage.calibration_path).resolve())
    cal.load()
    app.state.store = store
    app.state.worker = worker
    app.state.calibration = cal
    log.info("Capture worker started; mode=%s", settings.camera.mode)
    try:
        yield
    finally:
        worker.stop()


app = FastAPI(title="ABB Calibration — Camera Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.server.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- request / response models ------------------------------------

class ClickRequest(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    snap: bool = True  # ignored when no calibration is loaded


class ClickResponse(BaseModel):
    pixel: tuple[int, int]
    depth_metres: float
    camera_xyz_m: tuple[float, float, float]
    calibrated: bool
    robot_xyz_m: tuple[float, float, float] | None = None
    snapped: bool = False
    residual_to_plane_mm: float | None = None


class IntrinsicsResponse(BaseModel):
    width: int
    height: int
    fx: float
    fy: float
    ppx: float
    ppy: float
    model: str
    coeffs: tuple[float, ...]
    depth_scale: float


class DeviceInfoResponse(BaseModel):
    name: str
    serial: str
    firmware: str
    usb_type: str
    is_usb2: bool


class ProfileResponse(BaseModel):
    name: str
    width: int
    height: int
    fps: int
    is_degraded: bool


class StatusResponse(BaseModel):
    mode_setting: str
    is_connected: bool
    device: DeviceInfoResponse | None
    profile: ProfileResponse | None


class CornerPairInput(BaseModel):
    pixel: tuple[int, int]
    camera_xyz_m: tuple[float, float, float]
    robot_xyz: tuple[float, float, float]  # in user-specified units


class CalibrationRequest(BaseModel):
    corners: list[CornerPairInput] = Field(min_length=3)
    units: Literal["mm", "m"] = "mm"


class PointPairResponse(BaseModel):
    pixel: tuple[int, int]
    camera_xyz_m: tuple[float, float, float]
    robot_xyz_m: tuple[float, float, float]


class CalibrationResponse(BaseModel):
    created_at: str
    units_input: str
    num_points: int
    rmse_mm: float
    point_pairs: list[PointPairResponse]


def _calibration_to_response(cal: cal_state.Calibration) -> CalibrationResponse:
    return CalibrationResponse(
        created_at=cal.created_at,
        units_input=cal.units_input,
        num_points=cal.num_points,
        rmse_mm=cal.rmse_mm,
        point_pairs=[
            PointPairResponse(
                pixel=pp.pixel,
                camera_xyz_m=pp.camera_xyz_m,
                robot_xyz_m=pp.robot_xyz_m,
            )
            for pp in cal.point_pairs
        ],
    )


# ---------- health / status ----------------------------------------------

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status", response_model=StatusResponse)
def status() -> StatusResponse:
    worker: CaptureWorker = app.state.worker
    store: FrameStore = app.state.store
    cam = worker.last_camera
    device = (
        DeviceInfoResponse(
            name=cam.device_info.name,
            serial=cam.device_info.serial,
            firmware=cam.device_info.firmware,
            usb_type=cam.device_info.usb_type,
            is_usb2=cam.device_info.is_usb2,
        )
        if cam is not None
        else None
    )
    profile = (
        ProfileResponse(
            name=cam.profile.name,
            width=cam.profile.width,
            height=cam.profile.height,
            fps=cam.profile.fps,
            is_degraded=cam.profile.is_degraded,
        )
        if cam is not None
        else None
    )
    return StatusResponse(
        mode_setting=settings.camera.mode,
        is_connected=store.is_connected,
        device=device,
        profile=profile,
    )


@app.get("/api/intrinsics", response_model=IntrinsicsResponse)
def intrinsics() -> IntrinsicsResponse:
    worker: CaptureWorker = app.state.worker
    cam = worker.last_camera
    if cam is None:
        raise HTTPException(status_code=404, detail="No camera has been attached yet.")
    intr = cam.color_intrinsics
    return IntrinsicsResponse(
        width=intr.width,
        height=intr.height,
        fx=intr.fx,
        fy=intr.fy,
        ppx=intr.ppx,
        ppy=intr.ppy,
        model=intr.model,
        coeffs=intr.coeffs,
        depth_scale=cam.depth_scale,
    )


# ---------- streams ------------------------------------------------------

@app.get("/stream/color")
def stream_color():
    store: FrameStore = app.state.store
    return StreamingResponse(mjpeg_generator(store, "color"), media_type=MEDIA_TYPE)


@app.get("/stream/depth")
def stream_depth():
    store: FrameStore = app.state.store
    return StreamingResponse(mjpeg_generator(store, "depth"), media_type=MEDIA_TYPE)


# ---------- click --------------------------------------------------------

@app.post("/api/click", response_model=ClickResponse)
def click(req: ClickRequest) -> ClickResponse:
    worker: CaptureWorker = app.state.worker
    store: FrameStore = app.state.store
    if not store.is_connected:
        raise HTTPException(status_code=503, detail="Camera disconnected.")
    cam = worker.last_camera
    if cam is None:
        raise HTTPException(status_code=503, detail="Camera disconnected.")
    raw_depth = store.depth_at(req.x, req.y)
    if raw_depth is None:
        raise HTTPException(status_code=404, detail="Pixel out of range or no frames yet.")
    if raw_depth == 0:
        raise HTTPException(status_code=409, detail="No depth at this pixel (hole or out-of-range).")

    depth_metres = raw_depth * cam.depth_scale
    camera_xyz = cam.deproject(req.x, req.y, depth_metres)

    cal_store: cal_state.CalibrationStore = app.state.calibration
    cal = cal_store.get()
    if cal is None:
        return ClickResponse(
            pixel=(req.x, req.y),
            depth_metres=depth_metres,
            camera_xyz_m=camera_xyz,
            calibrated=False,
        )

    cam_pt = np.array(camera_xyz, dtype=np.float64)
    residual_mm = cal.plane.signed_distance(cam_pt) * 1000.0
    snapped = bool(req.snap)
    point_for_transform = cal.plane.project(cam_pt) if snapped else cam_pt
    robot_xyz = cal.transform.apply(point_for_transform)
    return ClickResponse(
        pixel=(req.x, req.y),
        depth_metres=depth_metres,
        camera_xyz_m=camera_xyz,
        calibrated=True,
        robot_xyz_m=(float(robot_xyz[0]), float(robot_xyz[1]), float(robot_xyz[2])),
        snapped=snapped,
        residual_to_plane_mm=float(residual_mm),
    )


# ---------- calibration --------------------------------------------------

@app.get("/api/calibration", response_model=CalibrationResponse | None)
def get_calibration() -> CalibrationResponse | None:
    cal_store: cal_state.CalibrationStore = app.state.calibration
    cal = cal_store.get()
    return _calibration_to_response(cal) if cal is not None else None


@app.post("/api/calibration", response_model=CalibrationResponse)
def post_calibration(req: CalibrationRequest) -> CalibrationResponse:
    if len(req.corners) < 3:
        raise HTTPException(status_code=400, detail="Need at least 3 corners.")
    scale = 0.001 if req.units == "mm" else 1.0
    pairs = [
        cal_state.PointPair(
            pixel=(int(c.pixel[0]), int(c.pixel[1])),
            camera_xyz_m=(float(c.camera_xyz_m[0]), float(c.camera_xyz_m[1]), float(c.camera_xyz_m[2])),
            robot_xyz_m=(
                float(c.robot_xyz[0]) * scale,
                float(c.robot_xyz[1]) * scale,
                float(c.robot_xyz[2]) * scale,
            ),
        )
        for c in req.corners
    ]
    try:
        cal = cal_state.compute(pairs, units_input=req.units)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    cal_store: cal_state.CalibrationStore = app.state.calibration
    cal_store.save(cal)
    return _calibration_to_response(cal)


@app.delete("/api/calibration", status_code=204)
def delete_calibration() -> None:
    cal_store: cal_state.CalibrationStore = app.state.calibration
    cal_store.clear()


# ---------- robot ---------------------------------------------------------

class MoveToRequest(BaseModel):
    x_mm: float
    y_mm: float
    z_mm: float


class StepRequest(BaseModel):
    step_number: int = Field(ge=0)


def _open_robot() -> RobotClient:
    return RobotClient(
        host=settings.robot.host,
        port=settings.robot.port,
        connect_timeout_s=settings.robot.connect_timeout_s,
        motion_timeout_s=settings.robot.motion_timeout_s,
    )


def _dispatch(action) -> dict[str, bool]:
    # Per-request open/send/quit/close, matching the CLI. Cost is ~50 ms of
    # TCP overhead per call, acceptable for click-driven UI. Concurrent
    # requests serialise at the IRC5 (it accepts one client at a time);
    # the second caller blocks at TCP connect until the first sends QUIT.
    try:
        with _open_robot() as client:
            action(client)
    except (ConnectionError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"controller unreachable: {e}")
    except RobotTimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except RobotMotionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except RobotProtocolError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except RobotError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@app.post("/api/robot/move-to")
def post_robot_move_to(req: MoveToRequest) -> dict[str, bool]:
    return _dispatch(lambda c: c.move_to(req.x_mm, req.y_mm, req.z_mm))


@app.post("/api/robot/step")
def post_robot_step(req: StepRequest) -> dict[str, bool]:
    return _dispatch(lambda c: c.step(req.step_number))
