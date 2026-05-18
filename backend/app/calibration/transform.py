"""Math for camera→robot calibration.

Two pieces, both pure-numpy:

* `kabsch_rigid` — least-squares rigid 3D alignment (rotation + translation,
  no scale) from N point-pair correspondences. Solves
      argmin_{R, t} Σ ‖ R · cam_i + t − robot_i ‖²
  via SVD. The reflection-fix on the determinant ensures R is a proper
  rotation (det = +1), not an improper one (det = −1).

* `fit_plane` / `project_onto_plane` — best-fit plane through N points
  (PCA: smallest singular vector of the centred point cloud is the
  normal) and orthogonal projection onto it. Used to "snap" a click
  to the table surface so depth noise doesn't make the robot jitter.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class RigidTransform:
    """Camera-frame metres → robot-frame metres."""
    R: np.ndarray  # (3, 3) rotation, det = +1
    t: np.ndarray  # (3,) translation in metres
    rmse_m: float  # fit residual on the calibration points, metres

    def apply(self, points_cam: np.ndarray) -> np.ndarray:
        """points_cam: (3,) or (N, 3). Returns same shape, in robot frame."""
        single = points_cam.ndim == 1
        p = points_cam[None, :] if single else points_cam
        out = (self.R @ p.T).T + self.t
        return out[0] if single else out


@dataclass(frozen=True)
class Plane:
    """Plane in camera frame: { p : normal · (p − centroid) = 0 }."""
    normal: np.ndarray  # (3,) unit vector
    centroid: np.ndarray  # (3,) point on the plane

    def signed_distance(self, point: np.ndarray) -> float:
        return float(np.dot(point - self.centroid, self.normal))

    def project(self, point: np.ndarray) -> np.ndarray:
        return point - self.signed_distance(point) * self.normal


def kabsch_rigid(camera_points: np.ndarray, robot_points: np.ndarray) -> RigidTransform:
    """Solve for the rigid transform mapping camera_points → robot_points.

    Both arrays must be (N, 3) with N ≥ 3. Both in metres.
    Raises ValueError on degenerate input (e.g. all points collinear).
    """
    cam = np.asarray(camera_points, dtype=np.float64)
    rob = np.asarray(robot_points, dtype=np.float64)
    if cam.shape != rob.shape or cam.ndim != 2 or cam.shape[1] != 3:
        raise ValueError(f"Both inputs must be (N, 3); got {cam.shape} and {rob.shape}")
    if cam.shape[0] < 3:
        raise ValueError(f"Need ≥3 point pairs; got {cam.shape[0]}")

    cam_mean = cam.mean(axis=0)
    rob_mean = rob.mean(axis=0)
    cam_c = cam - cam_mean
    rob_c = rob - rob_mean

    # Cross-covariance matrix
    H = cam_c.T @ rob_c  # (3, 3)
    U, _, Vt = np.linalg.svd(H)
    # Reflection fix: ensure proper rotation (det = +1)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    if d == 0:
        d = 1.0
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    t = rob_mean - R @ cam_mean

    transformed = (R @ cam.T).T + t
    rmse = float(np.sqrt(np.mean(np.sum((transformed - rob) ** 2, axis=1))))
    return RigidTransform(R=R, t=t, rmse_m=rmse)


def fit_plane(points: np.ndarray) -> Plane:
    """Best-fit plane (least-squares orthogonal regression) through N points.

    points: (N, 3), N ≥ 3. Returns a unit-normal plane.
    """
    p = np.asarray(points, dtype=np.float64)
    if p.ndim != 2 or p.shape[1] != 3 or p.shape[0] < 3:
        raise ValueError(f"Need (N, 3) with N≥3; got {p.shape}")
    centroid = p.mean(axis=0)
    centred = p - centroid
    # Smallest singular vector = direction of least variance = plane normal
    _, _, Vt = np.linalg.svd(centred, full_matrices=False)
    normal = Vt[-1]
    norm = float(np.linalg.norm(normal))
    if norm < 1e-12:
        raise ValueError("Degenerate point set; cannot fit plane.")
    return Plane(normal=normal / norm, centroid=centroid)
