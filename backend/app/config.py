from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class CameraProfile(BaseModel):
    name: str
    width: int
    height: int
    fps: int
    is_degraded: bool = False


# Two named camera profiles. USB 3 supports 640x480 @ 30 fps comfortably
# for both color and depth. USB 2 cannot — drop to a configuration that
# fits within USB 2.0/2.1 bandwidth.
USB3_PROFILE = CameraProfile(name="USB 3 (full)", width=640, height=480, fps=30)
USB2_PROFILE = CameraProfile(
    name="USB 2 (degraded)", width=424, height=240, fps=15, is_degraded=True
)


CameraMode = Literal["auto", "usb3", "usb2"]


class CameraSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CAMERA_", env_file=".env", extra="ignore")

    # "auto" detects the USB type and picks the right profile.
    # "usb3" / "usb2" force a specific profile regardless of detection.
    mode: CameraMode = "auto"

    enable_spatial_filter: bool = True
    enable_temporal_filter: bool = True
    enable_hole_filling: bool = True

    jpeg_quality: int = 80


class ServerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SERVER_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])


class StorageSettings(BaseSettings):
    """Where the backend persists its state.

    In a container, mount these paths as volumes so calibration survives restarts.
    """
    model_config = SettingsConfigDict(env_prefix="STORAGE_", env_file=".env", extra="ignore")

    # Path to the calibration JSON file. Relative paths resolve against the
    # backend working directory.
    calibration_path: str = "calibration.json"


class RobotSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ROBOT_", env_file=".env", extra="ignore")

    # Matches the legacy IRC5 setup. Override via ROBOT_HOST env var (or .env)
    # to point at "127.0.0.1" for a RobotStudio Virtual Controller.
    host: str = "192.168.125.1"
    port: int = 5000
    connect_timeout_s: float = 5.0
    motion_timeout_s: float = 30.0


class Settings(BaseSettings):
    camera: CameraSettings = Field(default_factory=CameraSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    robot: RobotSettings = Field(default_factory=RobotSettings)


settings = Settings()
