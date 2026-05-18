export type Intrinsics = {
  width: number;
  height: number;
  fx: number;
  fy: number;
  ppx: number;
  ppy: number;
  model: string;
  coeffs: number[];
  depth_scale: number;
};

export type CameraStatus = {
  mode_setting: string;
  is_connected: boolean;
  device: {
    name: string;
    serial: string;
    firmware: string;
    usb_type: string;
    is_usb2: boolean;
  };
  profile: {
    name: string;
    width: number;
    height: number;
    fps: number;
    is_degraded: boolean;
  };
};

export async function fetchStatus(): Promise<CameraStatus> {
  const r = await fetch("/api/status");
  if (!r.ok) throw new Error(`status failed: ${r.status}`);
  return r.json();
}

export type ClickResult = {
  pixel: [number, number];
  depth_metres: number;
  camera_xyz_m: [number, number, number];
  calibrated: boolean;
  robot_xyz_m: [number, number, number] | null;
  snapped: boolean;
  residual_to_plane_mm: number | null;
};

export type ClickError = {
  status: number;
  detail: string;
};

export type CalibrationPointPair = {
  pixel: [number, number];
  camera_xyz_m: [number, number, number];
  robot_xyz_m: [number, number, number];
};

export type Calibration = {
  created_at: string; // ISO 8601
  units_input: "mm" | "m";
  num_points: number;
  rmse_mm: number;
  point_pairs: CalibrationPointPair[];
};

export type CalibrationCornerInput = {
  pixel: [number, number];
  camera_xyz_m: [number, number, number];
  robot_xyz: [number, number, number]; // in `units` from request
};

export async function fetchIntrinsics(): Promise<Intrinsics> {
  const r = await fetch("/api/intrinsics");
  if (!r.ok) throw new Error(`intrinsics failed: ${r.status}`);
  return r.json();
}

export async function clickPixel(
  x: number,
  y: number,
  snap: boolean,
): Promise<{ ok: ClickResult } | { err: ClickError }> {
  const r = await fetch("/api/click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x, y, snap }),
  });
  if (r.ok) {
    return { ok: (await r.json()) as ClickResult };
  }
  let detail = r.statusText;
  try {
    const body = (await r.json()) as { detail?: string };
    if (body.detail) detail = body.detail;
  } catch {
    // ignore parse errors; use statusText
  }
  return { err: { status: r.status, detail } };
}

export async function fetchCalibration(): Promise<Calibration | null> {
  const r = await fetch("/api/calibration");
  if (!r.ok) throw new Error(`calibration fetch failed: ${r.status}`);
  const body = (await r.json()) as Calibration | null;
  return body;
}

export async function postCalibration(
  corners: CalibrationCornerInput[],
  units: "mm" | "m",
): Promise<{ ok: Calibration } | { err: ClickError }> {
  const r = await fetch("/api/calibration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ corners, units }),
  });
  if (r.ok) return { ok: (await r.json()) as Calibration };
  let detail = r.statusText;
  try {
    const body = (await r.json()) as { detail?: string };
    if (body.detail) detail = body.detail;
  } catch {
    // ignore
  }
  return { err: { status: r.status, detail } };
}

export async function deleteCalibration(): Promise<void> {
  const r = await fetch("/api/calibration", { method: "DELETE" });
  if (!r.ok) throw new Error(`calibration delete failed: ${r.status}`);
}

export type RobotError = {
  status: number;
  detail: string;
};

async function postRobot(
  path: string,
  body: object,
): Promise<{ ok: true } | { err: RobotError }> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  let detail = r.statusText;
  try {
    const j = (await r.json()) as { detail?: string };
    if (j.detail) detail = j.detail;
  } catch {
    // ignore
  }
  return { err: { status: r.status, detail } };
}

export function robotMoveTo(
  x_mm: number,
  y_mm: number,
  z_mm: number,
): Promise<{ ok: true } | { err: RobotError }> {
  return postRobot("/api/robot/move-to", { x_mm, y_mm, z_mm });
}

export function robotStep(
  step_number: number,
): Promise<{ ok: true } | { err: RobotError }> {
  return postRobot("/api/robot/step", { step_number });
}
